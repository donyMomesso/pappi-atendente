// src/routes/bot.handler.js
// Lógica central do bot de pedidos

const { getClients } = require("../services/tenant.service");
const { findByCustomer } = require("../services/order.service");
const { map: mapPayment, listFormatted: listPayments } = require("../mappers/PaymentMapper");
const AddressNormalizer = require("../normalizers/AddressNormalizer");

// Estado de conversa em memória (simples; para produção use Redis)
// tenantId:phone → { step, cart, address, payment, ... }
const sessions = new Map();

function key(tenantId, phone) {
  return `${tenantId}:${phone}`;
}

function getSession(tenantId, phone) {
  const k = key(tenantId, phone);
  if (!sessions.has(k)) sessions.set(k, { step: "MENU", cart: [] });
  return sessions.get(k);
}

function clearSession(tenantId, phone) {
  sessions.delete(key(tenantId, phone));
}

/**
 * Ponto de entrada do bot para cada mensagem recebida.
 */
async function handle({ tenant, wa, customer, msg, text, phone }) {
  const session = getSession(tenant.id, phone);
  const { cw } = await getClients(tenant.id);

  // Verifica se loja está aberta
  const open = await cw.isOpen();
  if (!open) {
    await wa.sendText(phone, "😴 Estamos fechados no momento. Em breve voltamos!");
    clearSession(tenant.id, phone);
    return;
  }

  const t = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Palavras de reinício
  if (["oi", "ola", "ola!", "menu", "inicio", "começar", "comecar", "cardapio"].includes(t)) {
    clearSession(tenant.id, phone);
    await sendMainMenu(wa, phone, customer);
    return;
  }

  switch (session.step) {
    case "MENU":
      await handleMenu(wa, cw, phone, text, t, session, customer, tenant);
      break;
    case "CHOOSING_ITEMS":
      await handleChoosingItems(wa, cw, phone, text, t, session, customer, tenant);
      break;
    case "FULFILLMENT":
      await handleFulfillment(wa, phone, text, t, session, tenant);
      break;
    case "ADDRESS":
      await handleAddress(wa, phone, text, session, tenant);
      break;
    case "PAYMENT":
      await handlePayment(wa, cw, phone, text, session, customer, tenant);
      break;
    case "CONFIRM":
      await handleConfirm(wa, cw, phone, text, t, session, customer, tenant);
      break;
    default:
      await sendMainMenu(wa, phone, customer);
  }
}

// ── Etapas ───────────────────────────────────────────────────

async function sendMainMenu(wa, phone, customer) {
  const name = customer.name ? `, ${customer.name.split(" ")[0]}` : "";
  await wa.sendButtons(
    phone,
    `Olá${name}! 🍕 Bem-vindo ao Pappi!\n\nO que deseja fazer?`,
    [
      { id: "PEDIDO", title: "🛒 Fazer Pedido" },
      { id: "STATUS", title: "📦 Ver Meu Pedido" },
      { id: "CARDAPIO", title: "📋 Ver Cardápio" },
    ]
  );
}

async function handleMenu(wa, cw, phone, text, t, session, customer, tenant) {
  if (t.includes("pedido") || t === "pedido" || text === "PEDIDO") {
    session.step = "CHOOSING_ITEMS";
    const catalog = await cw.getCatalog();
    const categories = extractCategories(catalog);
    if (!categories.length) {
      await wa.sendText(phone, "Cardápio indisponível no momento. Tente novamente em instantes.");
      return;
    }
    await wa.sendText(
      phone,
      `📋 *Categorias disponíveis:*\n\n${categories.map((c, i) => `${i + 1}. ${c.name}`).join("\n")}\n\nDigite o número da categoria:`
    );
    session.categories = categories;
    return;
  }

  if (t.includes("status") || text === "STATUS") {
    const orders = await findByCustomer(customer.id, 3);
    if (!orders.length) {
      await wa.sendText(phone, "Você ainda não tem pedidos registrados.");
      return;
    }
    const lines = orders.map(
      (o) => `• Pedido #${o.id.slice(-6).toUpperCase()} — ${o.status} — R$ ${o.total.toFixed(2)}`
    );
    await wa.sendText(phone, `📦 *Seus últimos pedidos:*\n\n${lines.join("\n")}`);
    return;
  }

  if (t.includes("cardapio") || text === "CARDAPIO") {
    const catalog = await cw.getCatalog();
    const text2 = formatCatalogText(catalog);
    await wa.sendText(phone, text2 || "Cardápio indisponível no momento.");
    return;
  }

  await sendMainMenu(wa, phone, customer);
}

async function handleChoosingItems(wa, cw, phone, text, t, session, customer, tenant) {
  // Seleção de categoria pelo número
  if (!session.selectedCategory && session.categories) {
    const idx = parseInt(text.trim()) - 1;
    if (isNaN(idx) || !session.categories[idx]) {
      await wa.sendText(phone, "Número inválido. Digite o número da categoria:");
      return;
    }
    session.selectedCategory = session.categories[idx];
    const items = session.selectedCategory.items || [];
    await wa.sendText(
      phone,
      `*${session.selectedCategory.name}*\n\n${items.map((it, i) => `${i + 1}. ${it.name} — R$ ${parseFloat(it.price || 0).toFixed(2)}`).join("\n")}\n\nDigite o número do item ou *"finalizar"* para revisar o carrinho:`
    );
    session.categoryItems = items;
    return;
  }

  if (t === "finalizar" || t === "fechar" || t === "pronto") {
    if (!session.cart.length) {
      await wa.sendText(phone, "Seu carrinho está vazio. Escolha pelo menos um item.");
      return;
    }
    session.step = "FULFILLMENT";
    await wa.sendButtons(
      phone,
      `🛒 *Seu carrinho:*\n${cartSummary(session.cart)}\n\nComo deseja receber?`,
      [
        { id: "delivery", title: "🛵 Entrega" },
        { id: "takeout", title: "🏪 Retirada" },
      ]
    );
    return;
  }

  // Adiciona item pelo número
  if (session.categoryItems) {
    const idx = parseInt(text.trim()) - 1;
    if (!isNaN(idx) && session.categoryItems[idx]) {
      const item = session.categoryItems[idx];
      const existing = session.cart.find((c) => c.id === item.id);
      if (existing) {
        existing.quantity += 1;
      } else {
        session.cart.push({
          id: item.id,
          name: item.name,
          unit_price: parseFloat(item.price || 0),
          quantity: 1,
          addons: [],
        });
      }
      await wa.sendText(
        phone,
        `✅ *${item.name}* adicionado!\n\n${cartSummary(session.cart)}\n\nDigite outro número ou *"finalizar"*:`
      );
      return;
    }
  }

  await wa.sendText(phone, "Não entendi. Digite o número do item ou *\"finalizar\"*.");
}

async function handleFulfillment(wa, phone, text, t, session, tenant) {
  const isDelivery = t.includes("entrega") || text === "delivery";
  const isTakeout  = t.includes("retirada") || t.includes("buscar") || text === "takeout";

  if (!isDelivery && !isTakeout) {
    await wa.sendText(phone, "Escolha: *Entrega* ou *Retirada*");
    return;
  }

  session.fulfillment = isDelivery ? "delivery" : "takeout";

  if (isDelivery) {
    session.step = "ADDRESS";
    await wa.sendText(
      phone,
      "📍 Me informe o endereço de entrega:\n\nEx: _Rua das Flores, 123, Bairro Centro_"
    );
  } else {
    session.step = "PAYMENT";
    const { cw } = await getClients(tenant.id);
    const methods = await cw.getPaymentMethods();
    await wa.sendText(
      phone,
      `💳 *Forma de pagamento:*\n\n${listPayments(tenant.id)}\n\nDigite o nome do método:`
    );
  }
}

async function handleAddress(wa, phone, text, session, tenant) {
  const extracted = AddressNormalizer.fromText(text);
  const result    = AddressNormalizer.normalize({ ...extracted, city: tenant.city || "" });

  if (!result.ok) {
    await wa.sendText(
      phone,
      `⚠️ Endereço incompleto. Informe: *rua, número, bairro*\n\nEx: _Av. Brasil, 456, Jardim das Rosas_`
    );
    return;
  }

  session.address = result.address;
  session.step    = "PAYMENT";

  await wa.sendText(
    phone,
    `✅ Endereço: *${result.address.formatted}*\n\n💳 *Forma de pagamento:*\n\n${listPayments(tenant.id)}\n\nDigite o nome do método:`
  );
}

async function handlePayment(wa, cw, phone, text, session, customer, tenant) {
  const mapped = mapPayment(tenant.id, text);
  if (!mapped.matched) {
    await wa.sendText(
      phone,
      `❌ Método não encontrado. Escolha:\n\n${listPayments(tenant.id)}`
    );
    return;
  }

  session.paymentMethodId   = mapped.id;
  session.paymentMethodName = mapped.name;
  session.step = "CONFIRM";

  const deliveryLine = session.fulfillment === "delivery"
    ? `📍 *Endereço:* ${session.address?.formatted}\n` : "";

  await wa.sendButtons(
    phone,
    `📋 *Resumo do pedido:*\n\n${cartSummary(session.cart)}\n${deliveryLine}💳 *Pagamento:* ${mapped.name}\n\nConfirmar?`,
    [
      { id: "CONFIRMAR", title: "✅ Confirmar" },
      { id: "CANCELAR",  title: "❌ Cancelar"  },
    ]
  );
}

async function handleConfirm(wa, cw, phone, text, t, session, customer, tenant) {
  if (t.includes("cancel") || text === "CANCELAR") {
    clearSession(tenant.id, phone);
    await wa.sendText(phone, "Pedido cancelado. Quando quiser, é só chamar! 😊");
    return;
  }

  if (t.includes("confirm") || text === "CONFIRMAR") {
    await wa.sendText(phone, "⏳ Processando seu pedido...");

    const { createWithIdempotency, setCwOrderId } = require("../services/order.service");
    const { recordOrder } = require("../services/customer.service");
    const { calculate } = require("../calculators/OrderCalculator");

    // Calcula total
    const calc = calculate({ items: session.cart, deliveryFee: session.deliveryFee || 0 });

    // Monta payload CW
    const cwPayload = buildCwPayload({ session, customer, calc });

    let cwResponse = null;
    let cwOrderId  = null;
    let success    = false;

    try {
      cwResponse = await cw.createOrder(cwPayload);
      cwOrderId  = cwResponse?.id || cwResponse?.order_id;
      success    = true;
    } catch (err) {
      console.error(`[${tenant.id}] Erro ao criar pedido no CW:`, err.message);
    }

    // Salva localmente (mesmo se CW falhou — Req 4 fallback)
    const idempotencyKey = `${customer.id}:${Date.now()}`;
    const { order, created } = await createWithIdempotency({
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
      cwOrderId,
      cwPayload,
      cwResponse,
    });

    if (cwOrderId) await setCwOrderId(order.id, cwOrderId, cwResponse);

    await recordOrder(
      customer.id,
      cartSummary(session.cart),
      session.paymentMethodName
    );

    clearSession(tenant.id, phone);

    if (success) {
      await wa.sendText(
        phone,
        `✅ *Pedido confirmado!*\n\n${cartSummary(session.cart)}\n💳 ${session.paymentMethodName}\n⏱️ Previsão: 40–60 min\n\nObrigado! 🍕`
      );
    } else {
      await wa.sendText(
        phone,
        `✅ *Pedido recebido!*\n\nEstamos processando e entraremos em contato em breve.\n\nObrigado! 🍕`
      );
    }
    return;
  }

  await wa.sendText(phone, "Digite *Confirmar* ou *Cancelar*:");
}

// ── Helpers ──────────────────────────────────────────────────

function extractCategories(catalog) {
  if (!catalog) return [];
  if (Array.isArray(catalog)) return catalog.map((c) => ({ name: c.name || c.title, items: c.items || c.products || [] }));
  if (catalog.categories) return catalog.categories.map((c) => ({ name: c.name, items: c.items || c.products || [] }));
  if (catalog.data?.categories) return catalog.data.categories.map((c) => ({ name: c.name, items: c.items || [] }));
  return [];
}

function cartSummary(cart) {
  if (!cart.length) return "Carrinho vazio";
  const lines = cart.map((i) => `• ${i.quantity}x ${i.name} — R$ ${(i.unit_price * i.quantity).toFixed(2)}`);
  const total = cart.reduce((s, i) => s + i.unit_price * i.quantity, 0);
  return lines.join("\n") + `\n\n*Total: R$ ${total.toFixed(2)}*`;
}

function formatCatalogText(catalog) {
  const cats = extractCategories(catalog);
  if (!cats.length) return null;
  return cats
    .map(
      (c) =>
        `*${c.name}*\n${(c.items || []).map((i) => `  • ${i.name} — R$ ${parseFloat(i.price || 0).toFixed(2)}`).join("\n")}`
    )
    .join("\n\n");
}

function buildCwPayload({ session, customer, calc }) {
  const phone = customer.phone.startsWith("55")
    ? customer.phone.slice(2)
    : customer.phone;

  const payload = {
    customer: {
      name: customer.name || "Cliente WhatsApp",
      phone,
    },
    items: session.cart.map((i) => ({
      id: i.id,
      quantity: i.quantity,
      unit_price: i.unit_price,
      addons: i.addons || [],
    })),
    fulfillment: session.fulfillment,
    payment_method_id: session.paymentMethodId,
    total: calc.expectedTotal,
  };

  if (session.fulfillment === "delivery" && session.address) {
    payload.delivery_address = {
      street:       session.address.street,
      number:       session.address.number,
      complement:   session.address.complement,
      neighborhood: session.address.neighborhood,
      city:         session.address.city,
      state:        session.address.state,
      zip_code:     session.address.zipCode,
    };
    if (calc.deliveryFee) payload.delivery_fee = calc.deliveryFee;
  }

  return payload;
}

module.exports = { handle };
