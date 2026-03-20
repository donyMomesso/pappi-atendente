// src/routes/bot.handler.js
// CORREÇÕES:
//   - Mutex por usuário evita race condition em webhooks simultâneos
//   - Endereço confirmado é persistido no Customer (touchInteraction)
//   - Falha no CW gera alerta via Baileys para o operador
//   - Usa singleton do PrismaClient via serviços

const { randomUUID } = require("crypto");
const ENV = require("../config/env");
const { getClients } = require("../services/tenant.service");
const { map: mapPayment, listFormatted: listPayments } = require("../mappers/PaymentMapper");
const { round2 } = require("../calculators/OrderCalculator");
const AddressNormalizer = require("../normalizers/AddressNormalizer");
const Gemini = require("../services/gemini.service");
const chatMemory = require("../services/chat-memory.service");
const Maps = require("../services/maps.service");
const sessionService = require("../services/session.service");
const metaCapi = require("../services/meta-capi.service");
const { routeByTime } = require("../services/time-routing.service");
const aviseAbertura = require("../services/avise-abertura.service");

// ── Wrappers de sessão com mutex ──────────────────────────────
async function getSession(tenantId, phone) {
  return sessionService.get(tenantId, phone);
}
async function clearSession(tenantId, phone) {
  return sessionService.clear(tenantId, phone);
}
async function saveSession(tenantId, phone, session) {
  return sessionService.save(tenantId, phone, session);
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
      street: data.logradouro || "",
      neighborhood: data.bairro || "",
      city: data.localidade || "",
      state: data.uf || "SP",
      zipCode: cep,
    };
  } catch {
    return null;
  }
}

function isCep(text) {
  return /^\d{5}-?\d{3}$/.test(text.trim());
}

// ── Ponto de entrada — com mutex por usuário ──────────────────
async function handle({ tenant, wa, customer, text, phone }) {
  const lockKey = `${tenant.id}:${phone}`;

  // CORREÇÃO: mutex garante que dois webhooks simultâneos do mesmo usuário
  // não processem em paralelo, evitando race condition na sessão
  return sessionService.withLock(lockKey, async () => {
    return _handle({ tenant, wa, customer, text, phone });
  });
}

async function _handle({ tenant, wa, customer, text, phone }) {
  const session = await getSession(tenant.id, phone);
  const { cw } = await getClients(tenant.id);

  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  // Atendente e status sempre respondem, independente do horário
  if (t.includes("atendente") || t.includes("humano") || t.includes("falar com alguem")) {
    const { setHandoff } = require("../services/customer.service");
    await setHandoff(customer.id, true);
    await wa.sendText(phone, "Vou chamar um atendente pra te ajudar. Um momento! 👨‍💼");
    await chatMemory.push(customer.id, "bot", "Vou chamar um atendente pra te ajudar. Um momento! 👨‍💼");
    await clearSession(tenant.id, phone);
    require("../services/socket.service").emitQueueUpdate();
    return;
  }
  // Status do pedido — comandos PT-BR (t já normalizado)
  if (
    t.includes("onde esta") ||
    t.includes("meu pedido") ||
    t.includes("status") ||
    t.includes("situacao") ||
    t.includes("chegou") ||
    t.includes("quanto tempo") ||
    t.includes("previsao") ||
    t.includes("rastreio") ||
    t.includes("andamento")
  ) {
    await handleStatusQuery(wa, phone, customer, tenant);
    return;
  }

  // Roteamento por horário: 18h-23:30 = aberto | outros = mensagem por slot
  // SKIP_HOURS_CHECK=true desativa (para testes)
  // CLOSED_AS_LEAD=true permite pedidos quando fechado — salva como lead
  const skipHours = ENV.SKIP_HOURS_CHECK;
  const closedAsLead = ENV.CLOSED_AS_LEAD;
  const timeSlot = routeByTime();
  let storeOpen = skipHours ? true : timeSlot.isOpen;

  if (!storeOpen && !closedAsLead) {
    // Detectar "Me avise quando abrir" (botão envia title, texto pode ser "me avise")
    const isAviseIntent =
      t.includes("avise") ||
      t.includes("avisar") ||
      t.includes("me avise quando abrir") ||
      (text || "").trim() === "AVISE_ABERTURA";
    if (timeSlot.hasAviseButton && isAviseIntent) {
      const added = await aviseAbertura.addToAberturaList(tenant.id, phone);
      const m =
        "Perfeito! Assim que o forno atingir a temperatura ideal e abrirmos oficialmente, você será o primeiro a receber um toque aqui no Zap! 🍕🔥";
      await wa.sendText(phone, m);
      await chatMemory.push(customer.id, "bot", m);
      await clearSession(tenant.id, phone);
      return;
    }
    // Enviar mensagem do slot — com botão em Tarde e Pré-Abertura
    if (timeSlot.hasAviseButton) {
      await wa.sendButtons(phone, timeSlot.message, [
        { id: "AVISE_ABERTURA", title: "🔔 Me avise quando abrir" },
      ]);
    } else {
      await wa.sendText(phone, timeSlot.message);
    }
    await chatMemory.push(customer.id, "bot", timeSlot.message);
    await clearSession(tenant.id, phone);
    return;
  }
  if (!storeOpen && closedAsLead) {
    session.isLeadOrder = true;
  }

  // Comandos PT-BR para iniciar/menu (t já normalizado sem acentos)
  const menuTriggers = ["oi", "ola", "ola!", "menu", "inicio", "comecar", "cardapio", "opa", "e ai", "fala"];
  if (menuTriggers.includes(t)) {
    await clearSession(tenant.id, phone);
    const fresh = await getSession(tenant.id, phone);
    if (!storeOpen && closedAsLead) fresh.isLeadOrder = true;
    await sendGreeting(wa, cw, phone, customer, tenant, fresh);
    await saveSession(tenant.id, phone, fresh);
    return;
  }

  if (
    (t.includes("cancelar") || t.includes("cancel")) &&
    (t.includes("pedido") || t.includes("quero")) &&
    session.step !== "CONFIRM"
  ) {
    await handleCancelRequest(wa, phone, customer, tenant);
    return;
  }

  if (session.step === "MENU") {
    try {
      const intent = await Gemini.classifyIntent(text);
      if (intent === "STATUS") {
        await handleStatusQuery(wa, phone, customer, tenant);
        return;
      }
      if (intent === "CARDAPIO") {
        const merchant = await cw.getMerchant().catch(() => null);
        const url = merchant?.url || merchant?.website || "";
        const m = url
          ? `📱 Confira nosso cardápio completo: ${url}`
          : "Me diga o que deseja e eu te ajudo a montar o pedido! 😊";
        await wa.sendText(phone, m);
        await chatMemory.push(customer.id, "bot", m);
        return;
      }
      if (intent === "HANDOFF") {
        const { setHandoff } = require("../services/customer.service");
        await setHandoff(customer.id, true);
        const m = "Vou chamar um atendente pra te ajudar. Um momento! 👨‍💼";
        await wa.sendText(phone, m);
        await chatMemory.push(customer.id, "bot", m);
        await clearSession(tenant.id, phone);
        const socketService = require("../services/socket.service");
        socketService.emitQueueUpdate();
        return;
      }
    } catch {}
  }

  switch (session.step) {
    case "MENU":
      await sendFulfillmentPromptOnly(wa, phone, customer, tenant, session);
      break;
    case "ASK_NAME":
      await handleAskName(wa, cw, phone, text, session, customer, tenant);
      break;
    case "FULFILLMENT":
      await handleFulfillment(wa, cw, phone, text, t, session, customer, tenant);
      break;
    case "ADDRESS":
      await handleAddress(wa, cw, phone, text, session, customer, tenant);
      break;
    case "ADDRESS_NUMBER":
      await handleAddressNumber(wa, cw, phone, text, session, customer, tenant);
      break;
    case "ADDRESS_CONFIRM":
      await handleAddressConfirm(wa, cw, phone, text, t, session, customer, tenant);
      break;
    case "ORDERING":
      await handleOrdering(wa, cw, phone, text, session, customer, tenant);
      break;
    case "PAYMENT":
      await handlePayment(wa, phone, text, session, customer, tenant);
      break;
    case "CONFIRM":
      await handleConfirm(wa, cw, phone, text, t, session, customer, tenant);
      break;
    default:
      await sendFulfillmentPromptOnly(wa, phone, customer, tenant, session);
  }

  if (session._cleared) {
    await clearSession(tenant.id, phone);
  } else {
    await saveSession(tenant.id, phone, session);
  }
}

// ── Status do pedido ──────────────────────────────────────────
async function handleStatusQuery(wa, phone, customer, _tenant) {
  try {
    const prisma = require("../lib/db");
    const lastOrder = await prisma.order.findFirst({
      where: { customerId: customer.id },
      orderBy: { createdAt: "desc" },
    });

    if (!lastOrder) {
      const m = "Não encontrei nenhum pedido seu por aqui ainda. Quer fazer um? 😊";
      await wa.sendText(phone, m);
      await chatMemory.push(customer.id, "bot", m);
      return;
    }

    const statusLabels = {
      waiting_confirmation: "⏳ Aguardando confirmação da loja",
      confirmed: "✅ Confirmado pela loja",
      in_production: "👨‍🍳 Em produção",
      in_preparation: "👨‍🍳 Em produção",
      dispatched: "🛵 Saiu para entrega",
      delivered: "🎉 Entregue",
      cancelled: "❌ Cancelado",
    };

    const statusLabel = statusLabels[lastOrder.status] || lastOrder.status;
    const orderNum = lastOrder.id.slice(-6).toUpperCase();
    const time = new Date(lastOrder.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    const m = `📦 *Pedido #${orderNum}* (${time})\nStatus: ${statusLabel}`;

    await wa.sendText(phone, m);
    await chatMemory.push(customer.id, "bot", m);
  } catch (err) {
    console.error("[Bot] handleStatusQuery:", err.message);
  }
}

// ── Cancelamento ──────────────────────────────────────────────
async function handleCancelRequest(wa, phone, customer, tenant) {
  try {
    const prisma = require("../lib/db");
    const lastOrder = await prisma.order.findFirst({
      where: { customerId: customer.id, status: { notIn: ["delivered", "cancelled"] } },
      orderBy: { createdAt: "desc" },
    });

    if (!lastOrder) {
      const m = "Não encontrei nenhum pedido ativo para cancelar.";
      await wa.sendText(phone, m);
      await chatMemory.push(customer.id, "bot", m);
      return;
    }

    if (lastOrder.cwOrderId) {
      try {
        const { cw } = await getClients(tenant.id);
        await cw.cancelOrder(lastOrder.cwOrderId, "Cancelado pelo cliente via WhatsApp");
      } catch {}
    }

    const { updateStatus } = require("../services/order.service");
    await updateStatus(lastOrder.id, "cancelled", "webhook", "Cancelado pelo cliente via WhatsApp");

    const orderNum = lastOrder.id.slice(-6).toUpperCase();
    const m = `❌ Pedido *#${orderNum}* cancelado. Se precisar de algo, é só chamar! 😊`;
    await wa.sendText(phone, m);
    await chatMemory.push(customer.id, "bot", m);
  } catch (err) {
    console.error("[Bot] handleCancelRequest:", err.message);
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

  // ── CAPI: Contact (lead novo) ─────────────────────────────
  metaCapi.trackContact({ customer }).catch(() => {});

  const isVip = (customer.visitCount || 0) > 0;
  const firstName = customer.name.split(" ")[0];
  const storeName = tenant.name || "Pappi Pizza";

  let menuUrl = "";
  try {
    const merchant = await cw.getMerchant();
    menuUrl = merchant?.url || merchant?.website || merchant?.catalog_url || "";
  } catch {}

  const urlLine = menuUrl ? `\n📱 Cardápio: ${menuUrl}` : "";
  const leadLine = session.isLeadOrder
    ? "\n\n⚠️ _Estamos fechados no momento. Você pode deixar seu pedido — entraremos em contato quando abrirmos!_"
    : "";
  const greeting = isVip
    ? `Oi ${firstName}! Que bom te ver de novo! 🍕${urlLine}\n⏱️ Entrega 40-60 min | Retirada 30-40 min${leadLine}\n\nÉ Entrega ou Retirada?`
    : `Olá, ${firstName}! 👋 Bem-vindo(a) à ${storeName} 🍕${urlLine}\n⏱️ Entrega 40-60 min | Retirada 30-40 min${leadLine}\n\nÉ Entrega ou Retirada?`;

  session.step = "FULFILLMENT";
  await wa.sendButtons(phone, greeting, [
    { id: "delivery", title: "🚚 Entrega" },
    { id: "takeout", title: "🏪 Retirada" },
  ]);
  await chatMemory.push(customer.id, "bot", greeting);
}

// Prompt curto: só "É Entrega ou Retirada?" (sem repetir o greeting completo)
async function sendFulfillmentPromptOnly(wa, phone, customer, tenant, session) {
  session.step = "FULFILLMENT";
  const m = "É Entrega ou Retirada? Escolha uma opção abaixo 👇";
  await wa.sendButtons(phone, m, [
    { id: "delivery", title: "🚚 Entrega" },
    { id: "takeout", title: "🏪 Retirada" },
  ]);
  await chatMemory.push(customer.id, "bot", m);
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
  customer.name = updated.name;
  customer.visitCount = updated.visitCount;

  const firstName = name.split(" ")[0];
  await wa.sendText(phone, `Perfeito, ${firstName}! 👊🍕`);
  session.step = "MENU";
  await sendGreeting(wa, cw, phone, updated, tenant, session);
}

// ── FULFILLMENT ───────────────────────────────────────────────
async function handleFulfillment(wa, cw, phone, text, t, session, customer, tenant) {
  const isDelivery =
    t.includes("entrega") || text === "delivery" || (text || "").trim() === "delivery";
  const isTakeout =
    t.includes("retirada") ||
    t.includes("buscar") ||
    t.includes("retirar") ||
    text === "takeout" ||
    (text || "").trim() === "takeout";

  if (isDelivery) {
    session.fulfillment = "delivery";

    // CORREÇÃO: se o cliente já tem endereço salvo, oferece reutilizar
    if (customer.lastAddress) {
      session.step = "ADDRESS_CONFIRM";
      const addr = {
        formatted: customer.lastAddress,
        street: customer.lastStreet || "",
        number: customer.lastNumber || "",
        neighborhood: customer.lastNeighborhood || "",
        complement: customer.lastComplement || "",
        city: customer.lastCity || tenant.city || "",
        lat: customer.lastLat,
        lng: customer.lastLng,
      };
      session.address = addr;
      const m = `🛵 Usar o mesmo endereço da última vez?\n📍 *${addr.formatted}*`;
      await wa.sendButtons(phone, m, [
        { id: "confirm_addr", title: "✅ Sim, usar esse" },
        { id: "change_addr", title: "✏️ Outro endereço" },
      ]);
      await chatMemory.push(customer.id, "bot", m);
      return;
    }

    session.step = "ADDRESS";
    const m =
      "🛵 Entrega! ⏱️ 40 a 60 min.\nMe manda o CEP ou Rua + Número + Bairro (ou localização 📍) pra calcular a taxa:";
    await wa.sendText(phone, m);
    await chatMemory.push(customer.id, "bot", m);
    return;
  }

  if (isTakeout) {
    session.fulfillment = "takeout";
    await startOrdering(wa, cw, phone, session, customer, tenant);
    return;
  }

  await sendFulfillmentPromptOnly(wa, phone, customer, tenant, session);
}

// ── ADDRESS ───────────────────────────────────────────────────
// Acumula mensagens parciais (rua + número em várias msgs) e tenta parsear o conjunto
async function handleAddress(wa, cw, phone, text, session, customer, tenant) {
  const t = (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const isFulfillmentClick =
    t.includes("entrega") ||
    t.includes("retirada") ||
    t.includes("retirar") ||
    t === "delivery" ||
    t === "takeout";
  if (isFulfillmentClick) {
    session.addressBuffer = [];
    session.addressFailCount = 0;
    const m = "🛵 Me manda o CEP ou Rua + Número + Bairro (ou localização 📍) pra calcular a taxa:";
    await wa.sendText(phone, m);
    await chatMemory.push(customer.id, "bot", m);
    return;
  }

  // CEP sozinho — trata direto
  if (isCep(text.trim())) {
    session.addressBuffer = [];
    session.addressFailCount = 0;
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

  // Acumula texto de várias mensagens (ex: "rua" + "manuel carvalho" + "guerra junior" + "53")
  session.addressBuffer = session.addressBuffer || [];
  session.addressBuffer.push((text || "").trim());
  const combined = session.addressBuffer.join(" ").trim();
  session.addressFailCount = session.addressFailCount || 0;

  async function tryParseAddress(input) {
    let addr = await Gemini.extractAddress(input, tenant.city || "Campinas");
    if (!addr) {
      const ext = AddressNormalizer.fromText(input);
      const res = AddressNormalizer.normalize({ ...ext, city: tenant.city || "" });
      if (res.ok) addr = res.address;
    }
    return addr;
  }

  const addr = await tryParseAddress(combined);

  if (!addr?.street) {
    session.addressFailCount += 1;
    const minLenToReply = 8;
    if (combined.length < minLenToReply && session.addressBuffer.length < 2) {
      // Fragmento curto — não repetir "não entendi", só pedir o resto
      const m = "Pode mandar o endereço completo? Ex: Rua X, 123, Bairro — ou só o CEP";
      await wa.sendText(phone, m);
      await chatMemory.push(customer.id, "bot", m);
      return;
    }
    const isRepeat = session.addressFailCount >= 2;
    const m = isRepeat
      ? "Tenta o *CEP* (8 números, ex: 13051135) — é mais rápido! Ou Rua, Número, Bairro."
      : "Não consegui identificar. Me manda o *CEP* ou *Rua, Número, Bairro*:";
    await wa.sendText(phone, m);
    await chatMemory.push(customer.id, "bot", m);
    return;
  }

  session.addressBuffer = [];
  session.addressFailCount = 0;

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
  const fullAddress = [
    `${addr.street}, ${addr.number}`,
    addr.complement,
    addr.neighborhood,
    addr.city || tenant.city || "",
    addr.state,
    addr.zipCode,
  ]
    .filter(Boolean)
    .join(", ");

  let feeText = "";
  try {
    const geo = await Maps.quote(fullAddress, cw);
    if (geo) {
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

  if (!session.deliveryFee) {
    try {
      const fee = await cw.getDeliveryFee({});
      if (fee != null) {
        session.deliveryFee = fee;
        feeText = `\nTaxa: R$ ${fee.toFixed(2)}`;
      }
    } catch {}
  }

  session.address = addr;
  session.step = "ADDRESS_CONFIRM";

  const m = `Confere o endereço? 📍\n*${addr.formatted}*${feeText}`;
  await wa.sendButtons(phone, m, [
    { id: "confirm_addr", title: "✅ Confirmar" },
    { id: "change_addr", title: "✏️ Corrigir" },
  ]);
  await chatMemory.push(customer.id, "bot", m);
}

// ── ADDRESS_CONFIRM ───────────────────────────────────────────
async function handleAddressConfirm(wa, cw, phone, text, t, session, customer, tenant) {
  if (t.includes("corrig") || t.includes("errado") || text === "change_addr") {
    session.step = "ADDRESS";
    delete session.address;
    session.addressBuffer = [];
    session.addressFailCount = 0;
    await wa.sendText(phone, "Tudo bem! Me manda o endereço correto:");
    return;
  }
  // confirm_addr, "confirma", "sim", "ok" — segue para startOrdering abaixo

  // CORREÇÃO: persiste o endereço confirmado no banco para reutilizar na próxima vez
  if (session.address) {
    const { touchInteraction } = require("../services/customer.service");
    await touchInteraction(customer.id, session.address).catch(() => {});
    // Atualiza objeto em memória para evitar nova busca
    customer.lastAddress = session.address.formatted;
    customer.lastStreet = session.address.street;
    customer.lastNumber = session.address.number;
    customer.lastNeighborhood = session.address.neighborhood;
    customer.lastComplement = session.address.complement;
    customer.lastCity = session.address.city;
    customer.lastLat = session.address.lat;
    customer.lastLng = session.address.lng;
  }

  await startOrdering(wa, cw, phone, session, customer, tenant);
}

// ── startOrdering ─────────────────────────────────────────────
async function startOrdering(wa, cw, phone, session, customer, tenant) {
  const [rawCatalog] = await Promise.all([cw.getCatalog(), cw.getPaymentMethods()]);
  // Normaliza: CardápioWeb pode retornar { catalog: {...} }, { data: {...} } ou { categories: [...] }
  session.catalog = rawCatalog?.catalog || rawCatalog?.data || rawCatalog;
  if (!session.catalog?.categories?.length && !session.catalog?.sections?.length) {
    console.warn(`[${tenant.id}] Catálogo vazio ou formato inesperado - cliente pode receber "Pode repetir"`);
  }
  session.step = "ORDERING";
  session.orderHistory = [];

  // ── CAPI: ViewContent (cliente acessou o cardápio) ──────────
  metaCapi.trackViewContent({ customer, tenantName: tenant.name }).catch(() => {});

  const isVip = (customer.visitCount || 0) > 0;
  const firstName = customer.name?.split(" ")[0] || "";
  const last = customer.lastOrderSummary;

  const m =
    isVip && last
      ? `Fechado ✅ Pronto pra pedir, ${firstName}! 🍕\n_(da última vez você pediu: ${last})_\n\nQuer o mesmo ou vai mudar?`
      : `Fechado ✅ Agora me diz seu pedido 🍕\n_(tamanho + sabor, ou meia a meia)_`;

  await wa.sendText(phone, m);
  await chatMemory.push(customer.id, "bot", m);
}

// ── ORDERING ──────────────────────────────────────────────────
async function handleOrdering(wa, cw, phone, text, session, customer, tenant) {
  session.orderHistory.push({ role: "customer", text });

  const result = await Gemini.chatOrder({
    history: session.orderHistory,
    catalog: session.catalog,
    customerName: customer.name,
    lastOrder: customer.lastOrderSummary,
    storeName: tenant.name || "Pappi Pizza",
    city: tenant.city || "Campinas",
    isVip: (customer.visitCount || 0) > 0,
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

  session.paymentMethodId = mapped.id;
  session.paymentMethodName = mapped.name;
  session.step = "CONFIRM";

  const { calculate } = require("../calculators/OrderCalculator");
  const calc = calculate({ items: session.cart, deliveryFee: session.deliveryFee || 0 });
  session.calc = calc;

  // ── CAPI: InitiateCheckout ────────────────────────────────
  metaCapi
    .trackInitiateCheckout({ customer, cart: session.cart, deliveryFee: session.deliveryFee || 0 })
    .catch(() => {});

  const addrLine =
    session.fulfillment === "delivery" && session.address ? `📍 *Endereço:* ${session.address.formatted}\n` : "";
  const feeLine = session.deliveryFee ? `🛵 *Taxa:* R$ ${session.deliveryFee.toFixed(2)}\n` : "";

  const m = `📋 *Resumo do pedido:*\n\n${cartSummary(session.cart)}\n${feeLine}${addrLine}💳 *Pagamento:* ${mapped.name}\n\nConfirmar?`;
  await wa.sendButtons(phone, m, [
    { id: "CONFIRMAR", title: "✅ Confirmar" },
    { id: "CANCELAR", title: "❌ Cancelar" },
  ]);
  await chatMemory.push(customer.id, "bot", m);
}

// ── CONFIRM ───────────────────────────────────────────────────
async function handleConfirm(wa, cw, phone, text, t, session, customer, tenant) {
  if (t.includes("cancel") || text === "CANCELAR") {
    session._cleared = true;
    await wa.sendText(phone, "Pedido cancelado. Quando quiser, é só chamar! 😊");
    return;
  }

  await wa.sendText(phone, "⏳ Processando seu pedido...");

  const { createWithIdempotency, setCwOrderId } = require("../services/order.service");
  const { recordOrder } = require("../services/customer.service");
  const { calculate } = require("../calculators/OrderCalculator");
  const baileys = require("../services/baileys.service");

  const calc = session.calc || calculate({ items: session.cart, deliveryFee: session.deliveryFee || 0 });
  const isLead = !!session.isLeadOrder;

  let cwResponse = null,
    cwOrderId = null,
    cwSuccess = false;
  let cwPayload = null;

  if (!isLead) {
    cwPayload = buildCwPayload({ session, customer, calc });
    try {
      cwResponse = await cw.createOrder(cwPayload);
      cwOrderId = cwResponse?.id || cwResponse?.order_id;
      cwSuccess = true;
    } catch (err) {
      console.error(`[${tenant.id}] Erro CW createOrder:`, err.message);
      const orderRef = `${customer.name || phone} — R$ ${calc.expectedTotal.toFixed(2)}`;
      baileys
        .notify(
          `🚨 *Falha ao enviar pedido ao CardápioWeb!*\n👤 ${orderRef}\n⚠️ Erro: ${err.message}\n\nPedido salvo localmente — verifique o painel.`,
        )
        .catch(() => {});
    }
  } else {
    // Pedido feito quando fechado (fluxo lead) — não envia ao CW, alerta operador
    const orderRef = `${customer.name || phone} — R$ ${calc.expectedTotal.toFixed(2)}`;
    baileys
      .notify(
        `📝 *Novo pedido LEAD* (loja fechada)\n👤 ${orderRef}\n${cartSummary(session.cart)}\n\nEntre em contato quando abrir!`,
      )
      .catch(() => {});
  }

  const idempotencyKey = `${customer.id}:${Date.now()}`;
  const { order } = await createWithIdempotency({
    tenantId: tenant.id,
    customerId: customer.id,
    idempotencyKey,
    items: session.cart,
    total: calc.expectedTotal,
    deliveryFee: calc.deliveryFee,
    fulfillment: session.fulfillment,
    address: session.address,
    paymentMethodId: session.paymentMethodId,
    paymentMethodName: session.paymentMethodName,
    cwOrderId: isLead ? null : cwOrderId,
    cwPayload: isLead ? null : cwPayload,
    cwResponse: isLead ? null : cwResponse,
    status: isLead ? "lead" : undefined,
  });

  if (cwOrderId) await setCwOrderId(order.id, cwOrderId, cwResponse);
  await recordOrder(customer.id, cartSummary(session.cart), session.paymentMethodName);

  // ── CAPI: Purchase ────────────────────────────────────────
  if (!isLead) {
    metaCapi
      .trackPurchase({
        customer,
        order: { id: order.id, total: calc.expectedTotal, fulfillment: session.fulfillment },
        items: session.cart,
      })
      .catch(() => {});
  }

  session._cleared = true;

  const orderNum = order.id.slice(-6).toUpperCase();
  const addrLine = session.address ? `\n📍 ${session.address.formatted}` : "";

  let m;
  if (isLead) {
    m = `✅ *Pedido #${orderNum} anotado!*\n\n${cartSummary(session.cart)}\n💳 ${session.paymentMethodName}${addrLine}\n\nEntraremos em contato quando abrirmos. Obrigado! 🍕`;
  } else if (cwSuccess) {
    m = `✅ *Pedido #${orderNum} confirmado!*\n\n${cartSummary(session.cart)}\n💳 ${session.paymentMethodName}${addrLine}\n⏱️ Previsão: 40–60 min\n\nObrigado! 🍕`;
  } else {
    m = `✅ *Pedido recebido!*\n\nEstamos processando e entraremos em contato em breve. Obrigado! 🍕`;
  }

  await wa.sendText(phone, m);
  await chatMemory.push(customer.id, "bot", m);
}

// ── Helpers ───────────────────────────────────────────────────
function cartSummary(cart) {
  if (!cart?.length) return "Carrinho vazio";
  const lines = cart.map((i) => `• ${i.quantity}x ${i.name} — R$ ${(i.unit_price * i.quantity).toFixed(2)}`);
  const total = cart.reduce((s, i) => s + i.unit_price * i.quantity, 0);
  return lines.join("\n") + `\n\n*Total: R$ ${total.toFixed(2)}*`;
}

function buildCwPayload({ session, customer, calc }) {
  const localPhone = customer.phone.startsWith("55") ? customer.phone.slice(2) : customer.phone;
  const phone11 = localPhone.replace(/\D/g, "").slice(-11);
  const cwOrderId = randomUUID();
  const displayId = cwOrderId.slice(-6).toUpperCase();

  const payload = {
    order_id: cwOrderId,
    display_id: displayId,
    order_type: session.fulfillment === "delivery" ? "delivery" : "takeout",
    created_at: new Date().toISOString(),
    customer: { phone: phone11, name: customer.name || "Cliente WhatsApp" },
    totals: {
      order_amount: calc.expectedTotal,
      delivery_fee: round2(calc.deliveryFee || 0),
      additional_fee: 0,
      discounts: round2(calc.discount || 0),
    },
    items: session.cart.map((i) => {
      const addons = i.addons || [];
      const addonsSum = addons.reduce((s, a) => s + (a.unit_price || 0) * (a.quantity || 1), 0);
      return {
        ...(i.id ? { item_id: String(i.id) } : {}),
        name: i.name,
        quantity: i.quantity,
        unit_price: i.unit_price,
        total_price: round2((i.unit_price + addonsSum) * i.quantity),
        ...(addons.length
          ? {
              options: addons.map((a) => ({
                name: a.name,
                quantity: a.quantity || 1,
                unit_price: a.unit_price || 0,
                ...(a.id ? { option_id: String(a.id) } : {}),
              })),
            }
          : {}),
      };
    }),
    payments: [
      {
        total: calc.expectedTotal,
        payment_method_id: parseInt(session.paymentMethodId, 10) || session.paymentMethodId,
      },
    ],
  };

  if (session.fulfillment === "delivery" && session.address) {
    payload.delivery_address = {
      state: session.address.state || "SP",
      city: session.address.city || "",
      neighborhood: session.address.neighborhood || "",
      street: session.address.street || "",
      number: session.address.number || "",
      postal_code: (session.address.zipCode || "").replace(/\D/g, ""),
      coordinates: {
        latitude: session.address.lat ?? 0,
        longitude: session.address.lng ?? 0,
      },
      ...(session.address.complement ? { complement: session.address.complement } : {}),
    };
  }

  return payload;
}

// ── Salva mensagem enviada pelo Baileys ───────────────────────
async function saveBaileysMessage(phone, text, tenantId, role = "assistant") {
  try {
    const prisma = require("../lib/db");
    const PhoneNormalizer = require("../normalizers/PhoneNormalizer");
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
  } catch (err) {
    console.error("[Bot] Erro ao salvar msg Baileys:", err.message);
  }
}

module.exports = { handle, saveBaileysMessage };
