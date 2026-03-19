// src/routes/bot.handler.js
// Motor de atendimento — fluxo natural com IA + modo VIP

const { randomUUID }     = require("crypto");
const { getClients }     = require("../services/tenant.service");
const { map: mapPayment, listFormatted: listPayments } = require("../mappers/PaymentMapper");
const { round2 }         = require("../calculators/OrderCalculator");
const AddressNormalizer  = require("../normalizers/AddressNormalizer");
const Gemini             = require("../services/gemini.service");
const chatMemory         = require("../services/chat-memory.service");
const Maps               = require("../services/maps.service");

// sessões em memória: "tenantId:phone" → { step, cart, orderHistory, ... }
const sessions = new Map();

function key(tenantId, phone)          { return `${tenantId}:${phone}`; }
function clearSession(tenantId, phone) { sessions.delete(key(tenantId, phone)); }

function getSession(tenantId, phone) {
  const k = key(tenantId, phone);
  if (!sessions.has(k)) sessions.set(k, { step: "MENU", cart: [], orderHistory: [] });
  return sessions.get(k);
}

// ── ViaCEP ────────────────────────────────────────────────────

async function lookupCep(raw) {
  try {
    const cep = raw.replace(/\D/g, "");
    if (cep.length !== 8) return null;
    const resp = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
    const data = await resp.json();
    if (data.erro) return null;
    return {
      street:       data.logradouro || "",
      neighborhood: data.bairro     || "",
      city:         data.localidade || "",
      state:        data.uf         || "SP",
      zipCode:      cep,
    };
  } catch { return null; }
}

function isCep(text) { return /^\d{5}-?\d{3}$/.test(text.trim()); }

// ── Ponto de entrada ──────────────────────────────────────────

async function handle({ tenant, wa, customer, text, phone }) {
  const session = getSession(tenant.id, phone);
  const { cw }  = await getClients(tenant.id);

  const open = await cw.isOpen();
  if (!open) {
    const m = "😴 Estamos fechados no momento. Em breve voltamos!";
    await wa.sendText(phone, m);
    await chatMemory.push(customer.id, "bot", m);
    clearSession(tenant.id, phone);
    return;
  }

  const t = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Palavras que reiniciam o fluxo
  if (["oi","ola","ola!","menu","inicio","comecar","cardapio","hey","oi!","olá"].includes(t)) {
    clearSession(tenant.id, phone);
    await sendGreeting(wa, cw, phone, customer, tenant, getSession(tenant.id, phone));
    return;
  }

  // Handoff em qualquer etapa
  if (t.includes("atendente") || t.includes("humano") || t.includes("falar com alguem")) {
    const { setHandoff } = require("../services/customer.service");
    await setHandoff(customer.id, true);
    await wa.sendText(phone, "Vou chamar um atendente pra te ajudar. Um momento! 👨‍💼");
    clearSession(tenant.id, phone);
    return;
  }

  switch (session.step) {
    case "MENU":            await sendGreeting(wa, cw, phone, customer, tenant, session);                  break;
    case "ASK_NAME":        await handleAskName(wa, cw, phone, text, session, customer, tenant);           break;
    case "FULFILLMENT":     await handleFulfillment(wa, cw, phone, text, t, session, customer, tenant);    break;
    case "ADDRESS":         await handleAddress(wa, cw, phone, text, session, customer, tenant);           break;
    case "ADDRESS_NUMBER":  await handleAddressNumber(wa, cw, phone, text, session, customer, tenant);     break;
    case "ADDRESS_CONFIRM": await handleAddressConfirm(wa, cw, phone, text, t, session, customer, tenant); break;
    case "ORDERING":        await handleOrdering(wa, cw, phone, text, session, customer, tenant);          break;
    case "PAYMENT":         await handlePayment(wa, phone, text, session, customer, tenant);               break;
    case "CONFIRM":         await handleConfirm(wa, cw, phone, text, t, session, customer, tenant);        break;
    default:                await sendGreeting(wa, cw, phone, customer, tenant, session);
  }
}

// ── Saudação ──────────────────────────────────────────────────

async function sendGreeting(wa, cw, phone, customer, tenant, session) {
  if (!customer.name) {
    session.step = "ASK_NAME";
    const m = "Oi! 😊 Qual seu nome pra eu anotar aqui?";
    await wa.sendText(phone, m);
    await chatMemory.push(customer.id, "bot", m);
    return;
  }

  const isVip     = (customer.visitCount || 0) > 0;
  const firstName = customer.name.split(" ")[0];
  const storeName = tenant.name || "Pappi Pizza";

  let menuUrl = "";
  try {
    const merchant = await cw.getMerchant();
    menuUrl = merchant?.url || merchant?.website || merchant?.catalog_url || "";
  } catch {}

  const urlLine = menuUrl ? `\n📱 Cardápio: ${menuUrl}` : "";

  const greeting = isVip
    ? `Oi ${firstName}! Que bom te ver de novo! 🍕${urlLine}\n⏱️ Entrega 40-60 min | Retirada 30-40 min\n\nÉ Entrega ou Retirada?`
    : `Olá, ${firstName}! 👋 Bem-vindo(a) à ${storeName} 🍕${urlLine}\n⏱️ Entrega 40-60 min | Retirada 30-40 min\n\nÉ Entrega ou Retirada?`;

  session.step = "FULFILLMENT";
  await wa.sendButtons(phone, greeting, [
    { id: "delivery", title: "🚚 Entrega" },
    { id: "takeout",  title: "🏪 Retirada" },
  ]);
  await chatMemory.push(customer.id, "bot", greeting);
}

// ── ASK_NAME ──────────────────────────────────────────────────

async function handleAskName(wa, cw, phone, text, session, customer, tenant) {
  const name = text.trim();
  if (!name || name.length < 2) {
    await wa.sendText(phone, "Pode me dizer seu nome? 😊");
    return;
  }

  const { setName } = require("../services/customer.service");
  const updated = await setName(customer.id, name);
  customer.name       = updated.name;
  customer.visitCount = updated.visitCount;

  const firstName = name.split(" ")[0];
  await wa.sendText(phone, `Perfeito, ${firstName}! 👊🍕`);

  session.step = "MENU";
  await sendGreeting(wa, cw, phone, updated, tenant, session);
}

// ── FULFILLMENT ───────────────────────────────────────────────

async function handleFulfillment(wa, cw, phone, text, t, session, customer, tenant) {
  const isDelivery = t.includes("entrega") || text === "delivery";
  const isTakeout  = t.includes("retirada") || t.includes("buscar") || t.includes("retirar") || text === "takeout";

  if (isDelivery) {
    session.fulfillment = "delivery";
    session.step = "ADDRESS";
    const m = "🛵 Entrega! ⏱️ 40 a 60 min.\nMe manda o CEP ou Rua + Número + Bairro (ou localização 📍) pra calcular a taxa:";
    await wa.sendText(phone, m);
    await chatMemory.push(customer.id, "bot", m);
    return;
  }

  if (isTakeout) {
    session.fulfillment = "takeout";
    await startOrdering(wa, cw, phone, session, customer, tenant);
    return;
  }

  await sendGreeting(wa, cw, phone, customer, tenant, { ...session, step: "MENU" });
}

// ── ADDRESS ───────────────────────────────────────────────────

async function handleAddress(wa, cw, phone, text, session, customer, tenant) {
  if (isCep(text.trim())) {
    const cepData = await lookupCep(text.trim());
    if (cepData) {
      session.partialAddress = cepData;
      session.step = "ADDRESS_NUMBER";
      const m = cepData.street
        ? `Perfeito ✅ *${cepData.street}* — ${cepData.neighborhood}\nQual o número da casa?`
        : "CEP encontrado! Qual a rua e número?";
      await wa.sendText(phone, m);
      await chatMemory.push(customer.id, "bot", m);
      return;
    }
  }

  let addr = await Gemini.extractAddress(text, tenant.city || "Campinas");
  if (!addr) {
    const ext = AddressNormalizer.fromText(text);
    const res  = AddressNormalizer.normalize({ ...ext, city: tenant.city || "" });
    if (res.ok) addr = res.address;
  }

  if (!addr?.street) {
    await wa.sendText(phone, "⚠️ Não consegui entender. Me manda o *CEP* ou *Rua, Número, Bairro*:");
    return;
  }

  if (!addr.number) {
    session.partialAddress = addr;
    session.step = "ADDRESS_NUMBER";
    const m = `*${addr.street}* — ${addr.neighborhood || ""}\nQual o número da casa?`;
    await wa.sendText(phone, m);
    await chatMemory.push(customer.id, "bot", m);
    return;
  }

  await confirmAddress(wa, cw, phone, addr, session, customer, tenant);
}

// ── ADDRESS_NUMBER ────────────────────────────────────────────

async function handleAddressNumber(wa, cw, phone, text, session, customer, tenant) {
  const number = text.trim();
  if (!number || number.length > 15) {
    await wa.sendText(phone, "Qual o número da casa?");
    return;
  }
  const addr = { ...session.partialAddress, number };
  delete session.partialAddress;
  await confirmAddress(wa, cw, phone, addr, session, customer, tenant);
}

async function confirmAddress(wa, cw, phone, addr, session, customer, tenant) {
  // Monta endereço completo para geocodificação
  const fullAddress = [
    `${addr.street}, ${addr.number}`,
    addr.complement,
    addr.neighborhood,
    addr.city || tenant.city || "",
    addr.state,
    addr.zipCode,
  ].filter(Boolean).join(", ");

  // Geocodifica com Google Maps + calcula distância e taxa
  let feeText = "";
  try {
    const geo = await Maps.quote(fullAddress, cw);
    if (geo) {
      // Usa endereço formatado pelo Maps se disponível
      addr.formatted = geo.formatted_address || fullAddress;
      addr.lat = geo.lat;
      addr.lng = geo.lng;

      if (geo.delivery_fee != null) {
        session.deliveryFee = geo.delivery_fee;
        const kmStr = geo.km != null ? ` | ${geo.km} km` : "";
        feeText = `\nTaxa: R$ ${geo.delivery_fee.toFixed(2)}${kmStr}`;
      }
    } else {
      addr.formatted = fullAddress;
    }
  } catch {
    addr.formatted = fullAddress;
  }

  // Fallback: tenta taxa do CW sem coordenadas
  if (!session.deliveryFee) {
    try {
      const fee = await cw.getDeliveryFee({});
      if (fee != null) { session.deliveryFee = fee; feeText = `\nTaxa: R$ ${fee.toFixed(2)}`; }
    } catch {}
  }

  session.address = addr;
  session.step    = "ADDRESS_CONFIRM";

  const m = `Confere o endereço? 📍\n*${addr.formatted}*${feeText}`;
  await wa.sendButtons(phone, m, [
    { id: "confirm_addr", title: "✅ Confirmar" },
    { id: "change_addr",  title: "✏️ Corrigir"  },
  ]);
  await chatMemory.push(customer.id, "bot", m);
}

// ── ADDRESS_CONFIRM ───────────────────────────────────────────

async function handleAddressConfirm(wa, cw, phone, text, t, session, customer, tenant) {
  if (t.includes("corrig") || t.includes("errado") || text === "change_addr") {
    session.step = "ADDRESS";
    delete session.address;
    await wa.sendText(phone, "Tudo bem! Me manda o endereço correto:");
    return;
  }
  await startOrdering(wa, cw, phone, session, customer, tenant);
}

// ── startOrdering ─────────────────────────────────────────────

async function startOrdering(wa, cw, phone, session, customer, tenant) {
  const [catalog] = await Promise.all([cw.getCatalog(), cw.getPaymentMethods()]);

  session.catalog      = catalog;
  session.step         = "ORDERING";
  session.orderHistory = [];

  const isVip     = (customer.visitCount || 0) > 0;
  const firstName = customer.name?.split(" ")[0] || "";
  const last      = customer.lastOrderSummary;

  const m = isVip && last
    ? `Fechado ✅ Pronto pra pedir, ${firstName}! 🍕\n_(da última vez você pediu: ${last})_\n\nQuer o mesmo ou vai mudar?`
    : `Fechado ✅ Agora me diz seu pedido 🍕\n_(tamanho + sabor, ou meia a meia)_`;

  await wa.sendText(phone, m);
  await chatMemory.push(customer.id, "bot", m);
}

// ── ORDERING — Gemini conduz a conversa livre ─────────────────

async function handleOrdering(wa, cw, phone, text, session, customer, tenant) {
  session.orderHistory.push({ role: "customer", text });

  const result = await Gemini.chatOrder({
    history:      session.orderHistory,
    catalog:      session.catalog,
    customerName: customer.name,
    lastOrder:    customer.lastOrderSummary,
    storeName:    tenant.name || "Pappi Pizza",
    city:         tenant.city || "Campinas",
    isVip:        (customer.visitCount || 0) > 0,
  });

  session.orderHistory.push({ role: "bot", text: result.reply });
  await wa.sendText(phone, result.reply);
  await chatMemory.push(customer.id, "bot", result.reply);

  if (result.done && result.items?.length > 0) {
    session.cart = result.items;
    session.step = "PAYMENT";
    const payMsg = `E o pagamento vai ser como? 💳\n\n${listPayments(tenant.id)}`;
    await wa.sendText(phone, payMsg);
    await chatMemory.push(customer.id, "bot", payMsg);
  }
}

// ── PAYMENT ───────────────────────────────────────────────────

async function handlePayment(wa, phone, text, session, customer, tenant) {
  const mapped = mapPayment(tenant.id, text);
  if (!mapped.matched) {
    await wa.sendText(phone, `❌ Método não encontrado. Escolha:\n\n${listPayments(tenant.id)}`);
    return;
  }

  session.paymentMethodId   = mapped.id;
  session.paymentMethodName = mapped.name;
  session.step = "CONFIRM";

  const { calculate } = require("../calculators/OrderCalculator");
  const calc = calculate({ items: session.cart, deliveryFee: session.deliveryFee || 0 });
  session.calc = calc;

  const addrLine = session.fulfillment === "delivery" && session.address
    ? `📍 *Endereço:* ${session.address.formatted}\n` : "";
  const feeLine = session.deliveryFee
    ? `🛵 *Taxa:* R$ ${session.deliveryFee.toFixed(2)}\n` : "";

  const m = `📋 *Resumo do pedido:*\n\n${cartSummary(session.cart)}\n${feeLine}${addrLine}💳 *Pagamento:* ${mapped.name}\n\nConfirmar?`;
  await wa.sendButtons(phone, m, [
    { id: "CONFIRMAR", title: "✅ Confirmar" },
    { id: "CANCELAR",  title: "❌ Cancelar"  },
  ]);
  await chatMemory.push(customer.id, "bot", m);
}

// ── CONFIRM ───────────────────────────────────────────────────

async function handleConfirm(wa, cw, phone, text, t, session, customer, tenant) {
  if (t.includes("cancel") || text === "CANCELAR") {
    clearSession(tenant.id, phone);
    await wa.sendText(phone, "Pedido cancelado. Quando quiser, é só chamar! 😊");
    return;
  }

  await wa.sendText(phone, "⏳ Processando seu pedido...");

  const { createWithIdempotency, setCwOrderId } = require("../services/order.service");
  const { recordOrder }                          = require("../services/customer.service");
  const { calculate }                            = require("../calculators/OrderCalculator");

  const calc      = session.calc || calculate({ items: session.cart, deliveryFee: session.deliveryFee || 0 });
  const cwPayload = buildCwPayload({ session, customer, calc });

  let cwResponse = null, cwOrderId = null, success = false;
  try {
    cwResponse = await cw.createOrder(cwPayload);
    cwOrderId  = cwResponse?.id || cwResponse?.order_id;
    success    = true;
  } catch (err) {
    console.error(`[${tenant.id}] Erro CW:`, err.message);
  }

  const idempotencyKey = `${customer.id}:${Date.now()}`;
  const { order } = await createWithIdempotency({
    tenantId: tenant.id, customerId: customer.id, idempotencyKey,
    items: session.cart, total: calc.expectedTotal, deliveryFee: calc.deliveryFee,
    fulfillment: session.fulfillment, address: session.address,
    paymentMethodId: session.paymentMethodId, paymentMethodName: session.paymentMethodName,
    cwOrderId, cwPayload, cwResponse,
  });

  if (cwOrderId) await setCwOrderId(order.id, cwOrderId, cwResponse);
  await recordOrder(customer.id, cartSummary(session.cart), session.paymentMethodName);
  clearSession(tenant.id, phone);

  const orderNum = order.id.slice(-6).toUpperCase();
  const addrLine = session.address ? `\n📍 ${session.address.formatted}` : "";
  const m = success
    ? `✅ *Pedido #${orderNum} confirmado!*\n\n${cartSummary(session.cart)}\n💳 ${session.paymentMethodName}${addrLine}\n⏱️ Previsão: 40–60 min\n\nObrigado! 🍕`
    : `✅ *Pedido recebido!*\n\nEstamos processando e entraremos em contato em breve. Obrigado! 🍕`;

  await wa.sendText(phone, m);
  await chatMemory.push(customer.id, "bot", m);
}

// ── Helpers ───────────────────────────────────────────────────

function cartSummary(cart) {
  if (!cart?.length) return "Carrinho vazio";
  const lines = cart.map(i => `• ${i.quantity}x ${i.name} — R$ ${(i.unit_price * i.quantity).toFixed(2)}`);
  const total = cart.reduce((s, i) => s + i.unit_price * i.quantity, 0);
  return lines.join("\n") + `\n\n*Total: R$ ${total.toFixed(2)}*`;
}

function buildCwPayload({ session, customer, calc }) {
  // Phone: apenas números, 11 dígitos locais (sem código do país)
  const localPhone = customer.phone.startsWith("55") ? customer.phone.slice(2) : customer.phone;
  const phone11    = localPhone.replace(/\D/g, "").slice(-11);

  const cwOrderId = randomUUID();
  const displayId = cwOrderId.slice(-6).toUpperCase();

  const payload = {
    order_id:   cwOrderId,
    display_id: displayId,
    order_type: session.fulfillment === "delivery" ? "delivery" : "takeout",
    created_at: new Date().toISOString(),
    customer: {
      phone: phone11,
      name:  customer.name || "Cliente WhatsApp",
    },
    totals: {
      order_amount:   calc.expectedTotal,
      delivery_fee:   round2(calc.deliveryFee || 0),
      additional_fee: 0,
      discounts:      round2(calc.discount   || 0),
    },
    items: session.cart.map(i => {
      const addons      = i.addons || [];
      const addonsSum   = addons.reduce((s, a) => s + (a.unit_price || 0) * (a.quantity || 1), 0);
      const total_price = round2((i.unit_price + addonsSum) * i.quantity);
      return {
        ...(i.id ? { item_id: String(i.id) } : {}),
        name:        i.name,
        quantity:    i.quantity,
        unit_price:  i.unit_price,
        total_price,
        ...(addons.length ? {
          options: addons.map(a => ({
            name:       a.name,
            quantity:   a.quantity || 1,
            unit_price: a.unit_price || 0,
            ...(a.id ? { option_id: String(a.id) } : {}),
          })),
        } : {}),
      };
    }),
    payments: [{
      total:             calc.expectedTotal,
      payment_method_id: parseInt(session.paymentMethodId, 10) || session.paymentMethodId,
    }],
  };

  // delivery_address é obrigatório para delivery — coordinates são exigidos pelo CW
  if (session.fulfillment === "delivery" && session.address) {
    payload.delivery_address = {
      state:        session.address.state        || "SP",
      city:         session.address.city         || "",
      neighborhood: session.address.neighborhood || "",
      street:       session.address.street       || "",
      number:       session.address.number       || "",
      postal_code:  (session.address.zipCode || "").replace(/\D/g, ""),
      coordinates: {
        latitude:  session.address.lat ?? 0,
        longitude: session.address.lng ?? 0,
      },
      ...(session.address.complement ? { complement: session.address.complement } : {}),
    };
  }

  return payload;
}

// ── Salva mensagem enviada pelo Baileys (WhatsApp interno) ─────

async function saveBaileysMessage(phone, text, tenantId, role = "assistant") {
  try {
    const { PrismaClient } = require("@prisma/client");
    const PhoneNormalizer = require("../normalizers/PhoneNormalizer");
    const prisma = new PrismaClient();

    // Normaliza o telefone para garantir que bate com o banco
    const normalizedPhone = PhoneNormalizer.normalize(phone) || phone;

    const customer = await prisma.customer.findUnique({
      where: { tenantId_phone: { tenantId, phone: normalizedPhone } },
    });
    if (customer) {
      const sender = role === "customer" ? null : "WhatsApp Auxiliar";
      await chatMemory.push(customer.id, role, text, sender, null, "text", null);
    } else {
      console.warn(`[BaileysMsg] Cliente não encontrado: ${normalizedPhone} (tenant: ${tenantId})`);
    }
    await prisma.$disconnect();
  } catch (err) {
    console.error("[Bot] Erro ao salvar msg Baileys:", err.message);
  }
}

module.exports = { handle, saveBaileysMessage };
