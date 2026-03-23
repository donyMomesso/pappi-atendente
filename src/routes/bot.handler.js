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
const ai = require("../services/ai.service");
const chatMemory = require("../services/chat-memory.service");
const Maps = require("../services/maps.service");
const sessionService = require("../services/session.service");
const metaCapi = require("../services/meta-capi.service");
const { routeByTime } = require("../services/time-routing.service");
const aviseAbertura = require("../services/avise-abertura.service");
const { needsDeescalation, detectHumanRequest } = require("../services/deescalation.service");

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

  // Atendente/humano: handoff imediato
  if (detectHumanRequest(text)) {
    const { setHandoff } = require("../services/customer.service");
    await setHandoff(customer.id, true);
    await wa.sendText(phone, "Vou chamar um atendente pra te ajudar. Um momento! 👨‍💼");
    await chatMemory.push(customer.id, "bot", "Vou chamar um atendente pra te ajudar. Um momento! 👨‍💼");
    await clearSession(tenant.id, phone);
    require("../services/socket.service").emitQueueUpdate();
    return;
  }

  // Deescalation: irritação sem pedido explícito de humano — oferece botões
  const orderSteps = [
    "MENU",
    "CHOOSE_PRODUCT_TYPE",
    "FULFILLMENT",
    "ADDRESS",
    "ADDRESS_NUMBER",
    "ADDRESS_CONFIRM",
    "ASK_SIZE",
    "ORDERING",
  ];
  if (needsDeescalation(text) && orderSteps.includes(session.step)) {
    session._beforeDeescalationStep = session.step;
    session.step = "DEESCALATION";
    await wa.sendButtons(phone, "Entendi 🙏 Vamos resolver agora. Como prefere?", [
      { id: "HELP_HUMAN", title: "👩‍💼 Atendente" },
      { id: "HELP_BOT", title: "✅ Continuar" },
      { id: "FULFILLMENT_RETIRADA", title: "🏪 Retirada" },
    ]);
    await chatMemory.push(customer.id, "bot", "Entendi 🙏 Vamos resolver agora. Como prefere?");
    await saveSession(tenant.id, phone, session);
    return;
  }

  // Resposta aos botões de deescalation
  if (session.step === "DEESCALATION") {
    if (text === "HELP_HUMAN" || t.includes("atendente")) {
      const { setHandoff } = require("../services/customer.service");
      await setHandoff(customer.id, true);
      await wa.sendText(phone, "Vou chamar um atendente pra te ajudar. Um momento! 👨‍💼");
      await chatMemory.push(customer.id, "bot", "Vou chamar um atendente pra te ajudar. Um momento! 👨‍💼");
      await clearSession(tenant.id, phone);
      require("../services/socket.service").emitQueueUpdate();
      return;
    }
    if (text === "HELP_BOT" || t.includes("continuar")) {
      const prev =
        session._beforeDeescalationStep ||
        (session.fulfillment
          ? session.chosenSize
            ? "ORDERING"
            : "ASK_SIZE"
          : session.productType
            ? "FULFILLMENT"
            : "CHOOSE_PRODUCT_TYPE");
      delete session._beforeDeescalationStep;
      session.step = prev;
      let m;
      if (prev === "ORDERING") m = "Beleza! Me diz seu pedido 🍕 (tamanho + sabor, ou meia a meia)";
      else if (prev === "ASK_SIZE")
        m = `Qual tamanho de ${session.productType === "lasanha" ? "lasanha" : "pizza"}?`; // será enviado com botões abaixo
      else if (prev === "FULFILLMENT") m = "Beleza! Deseja entrega ou retirada?";
      else m = "Beleza! Pizza ou lasanha?";
      if (prev === "ORDERING") {
        await wa.sendText(phone, m);
      } else if (prev === "ASK_SIZE" && session.sizeOptions?.length) {
        await wa.sendButtons(
          phone,
          m,
          session.sizeOptions.slice(0, 3).map((s) => ({ id: `size_${s}`, title: s })),
        );
      } else if (prev === "FULFILLMENT") {
        await wa.sendButtons(phone, m, [
          { id: "delivery", title: "🚚 Entrega" },
          { id: "takeout", title: "🏪 Retirada" },
        ]);
      } else {
        await wa.sendButtons(phone, m, [
          { id: "pizza", title: "🍕 Pizza" },
          { id: "lasanha", title: "🍝 Lasanha" },
        ]);
      }
      await chatMemory.push(customer.id, "bot", m);
      await saveSession(tenant.id, phone, session);
      return;
    }
    if (text === "FULFILLMENT_RETIRADA" || t.includes("retirada")) {
      session.fulfillment = "takeout";
      await startOrdering(wa, cw, phone, session, customer, tenant);
      await saveSession(tenant.id, phone, session);
      return;
    }
    // Resposta não reconhecida — reenvia os botões
    await wa.sendButtons(phone, "Escolha uma opção abaixo 👇", [
      { id: "HELP_HUMAN", title: "👩‍💼 Atendente" },
      { id: "HELP_BOT", title: "✅ Continuar" },
      { id: "FULFILLMENT_RETIRADA", title: "🏪 Retirada" },
    ]);
    await saveSession(tenant.id, phone, session);
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
      await aviseAbertura.addToAberturaList(tenant.id, phone);
      const m =
        "Perfeito! Assim que o forno atingir a temperatura ideal e abrirmos oficialmente, você será o primeiro a receber um toque aqui no Zap! 🍕🔥";
      await wa.sendText(phone, m);
      await chatMemory.push(customer.id, "bot", m);
      await clearSession(tenant.id, phone);
      return;
    }
    // Enviar mensagem do slot — com botão em Tarde e Pré-Abertura
    if (timeSlot.hasAviseButton) {
      await wa.sendButtons(phone, timeSlot.message, [{ id: "AVISE_ABERTURA", title: "🔔 Me avise quando abrir" }]);
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

  if (["MENU", "CHOOSE_PRODUCT_TYPE", "FULFILLMENT"].includes(session.step)) {
    try {
      const intent = await ai.classifyIntent(text);
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
      await sendProductTypePrompt(wa, phone, customer, session);
      break;
    case "CHOOSE_PRODUCT_TYPE":
      await handleChooseProductType(wa, cw, phone, text, t, session, customer, tenant);
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
    case "ASK_SIZE":
      await handleAskSize(wa, cw, phone, text, session, customer, tenant);
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
      await sendProductTypePrompt(wa, phone, customer, session);
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
  const storeName = tenant.name || "Pappi Pizza";

  if (!customer.name) {
    session.step = "ASK_NAME";
    const m = `Oi! 😊 Bem-vindo(a) à ${storeName}! Qual seu nome pra eu te atender?`;
    await wa.sendText(phone, m);
    await chatMemory.push(customer.id, "bot", m);
    return;
  }

  // ── CAPI: Contact (lead novo) ─────────────────────────────
  metaCapi.trackContact({ customer }).catch(() => {});

  const isVip = (customer.visitCount || 0) > 0;
  const firstName = customer.name.split(" ")[0];

  let menuUrl = "";
  try {
    const merchant = await cw.getMerchant();
    menuUrl = merchant?.url || merchant?.website || merchant?.catalog_url || "";
  } catch {}

  const urlLine = menuUrl ? `\n📱 Cardápio: ${menuUrl}` : "";
  const leadLine = session.isLeadOrder
    ? "\n\n⚠️ _Estamos fechados no momento. Você pode deixar seu pedido — entraremos em contato quando abrirmos!_"
    : "";

  // Bloco 1 — Saudação base (programada) + frase de impacto (IA ou fallback)
  const visits = customer.visitCount || 0;
  const baseGreeting = isVip
    ? `Oi ${firstName}! Que bom te ver de novo! 🍕`
    : `Olá, ${firstName}! 👋 Prazer em te conhecer!`;

  const FALLBACK_PHRASES = {
    new: "A noite pede pizza. Ou lasanha. E a gente tá pronta! 🍕",
    vip: "A noite pede pizza. Ou lasanha. E a gente tá pronta! 🍕",
  };

  let impactPhrase = FALLBACK_PHRASES[isVip ? "vip" : "new"];
  try {
    const history = await chatMemory.get(customer.id);
    const aiPhrase = await ai.generateGreetingPhrase({
      storeName,
      firstName,
      visitCount: visits,
      lastOrderSummary: customer.lastOrderSummary || "",
      conversationHistory: history,
      isNew: !isVip,
    });
    if (aiPhrase && aiPhrase.length > 5) {
      impactPhrase = aiPhrase;
    }
  } catch (err) {
    console.warn("[Bot] generateGreetingPhrase falhou, usando fallback:", err.message);
  }

  const greeting = `${baseGreeting}\n${impactPhrase}${urlLine}${leadLine}`;
  await wa.sendText(phone, greeting);
  await chatMemory.push(customer.id, "bot", greeting);

  // Bloco 2 — Escolha direta (D.I.S.C.: Dominância — objetivo, claro)
  session.step = "CHOOSE_PRODUCT_TYPE";
  const choiceMsg = "O que vai ser hoje? Escolha uma opção 👇";
  await wa.sendButtons(phone, choiceMsg, [
    { id: "pizza", title: "🍕 Pizza" },
    { id: "lasanha", title: "🍝 Lasanha" },
  ]);
  await chatMemory.push(customer.id, "bot", choiceMsg);
}

// Pergunta Pizza ou Lasanha
async function sendProductTypePrompt(wa, phone, customer, session) {
  session.step = "CHOOSE_PRODUCT_TYPE";
  const m = "O que vai ser hoje? Escolha uma opção 👇";
  await wa.sendButtons(phone, m, [
    { id: "pizza", title: "🍕 Pizza" },
    { id: "lasanha", title: "🍝 Lasanha" },
  ]);
  await chatMemory.push(customer.id, "bot", m);
}

// Pergunta Entrega ou Retirada
async function sendFulfillmentPromptOnly(wa, phone, customer, tenant, session) {
  session.step = "FULFILLMENT";
  const m = "Deseja entrega ou retirada? Escolha uma opção abaixo 👇";
  await wa.sendButtons(phone, m, [
    { id: "delivery", title: "🚚 Entrega" },
    { id: "takeout", title: "🏪 Retirada" },
  ]);
  await chatMemory.push(customer.id, "bot", m);
}

// ── Filtra catálogo por tipo (pizza/lasanha) e extrai tamanhos
function filterCatalogByProductType(catalog, productType) {
  const cats = catalog?.categories || catalog?.data?.categories || catalog?.sections || [];
  const key = productType === "lasanha" ? "lasanha" : "pizza";
  const filtered = cats.filter((c) => {
    const n = (c.name || c.title || "").toLowerCase();
    return key === "pizza" ? /pizza/.test(n) : /lasanha/.test(n);
  });
  const useCats = filtered.length ? filtered : cats;
  const sizes = new Set();
  for (const cat of useCats) {
    for (const item of cat.items || cat.products || []) {
      if (item.status === "INACTIVE") continue;
      for (const g of item.option_groups || []) {
        if (g.status === "INACTIVE" || !g.options) continue;
        const gn = (g.name || "").toLowerCase();
        if (/tamanho|size|fatias|escolha.*1/.test(gn)) {
          for (const o of g.options) {
            if (o.status !== "INACTIVE" && o.name) sizes.add(o.name.trim());
          }
        }
      }
    }
  }
  const sizeList = [...sizes].length ? [...sizes] : ["Broto", "Média", "Grande"];
  const outCatalog = filtered.length ? { categories: filtered } : catalog;
  return { catalog: outCatalog, sizes: sizeList };
}

// ── CHOOSE_PRODUCT_TYPE ───────────────────────────────────────
async function handleChooseProductType(wa, cw, phone, text, t, session, customer, tenant) {
  const isPizza = t.includes("pizza") || text === "pizza" || (text || "").trim() === "pizza";
  const isLasanha = t.includes("lasanha") || text === "lasanha" || (text || "").trim() === "lasanha";

  if (isPizza) {
    session.productType = "pizza";
  } else if (isLasanha) {
    session.productType = "lasanha";
  } else {
    await sendProductTypePrompt(wa, phone, customer, session);
    return;
  }

  await sendFulfillmentPromptOnly(wa, phone, customer, tenant, session);
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

  session.step = "MENU";
  await sendGreeting(wa, cw, phone, updated, tenant, session);
}

// ── FULFILLMENT ───────────────────────────────────────────────
async function handleFulfillment(wa, cw, phone, text, t, session, customer, tenant) {
  const isDelivery = t.includes("entrega") || text === "delivery" || (text || "").trim() === "delivery";
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
      "🛵 Entrega! ⏱️ 60 min.\nMe manda o CEP ou Rua + Número + Bairro (ou localização 📍) pra calcular a taxa:";
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
    t.includes("entrega") || t.includes("retirada") || t.includes("retirar") || t === "delivery" || t === "takeout";
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
    let addr = await ai.extractAddress(input, tenant.city || "Campinas");
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
async function startOrdering(wa, cw, phone, session, customer, _tenant) {
  const [rawCatalog] = await Promise.all([cw.getCatalog(), cw.getPaymentMethods()]);
  const fullCatalog = rawCatalog?.catalog || rawCatalog?.data || rawCatalog;
  session.catalog = fullCatalog;

  const productType = session.productType || "pizza";
  const { catalog: filteredCatalog, sizes } = filterCatalogByProductType(fullCatalog, productType);
  session.filteredCatalog = filteredCatalog;
  session.sizeOptions = sizes;

  const prefix =
    session.fulfillment === "takeout"
      ? "🏪 Beleza, retirada! ⏱️ 30 a 40 min. "
      : session.fulfillment === "delivery"
        ? "🛵 Pronto! "
        : "";

  if (!sizes.length) {
    session.step = "ORDERING";
    session.orderHistory = [];
    const m = `${prefix}Me diz seu pedido ${productType === "lasanha" ? "🍝" : "🍕"} (tamanho + sabor)`;
    await wa.sendText(phone, m);
    await chatMemory.push(customer.id, "bot", m);
    return;
  }

  session.step = "ASK_SIZE";
  const tipo = productType === "lasanha" ? "lasanha" : "pizza";
  const m = `${prefix}Qual tamanho de ${tipo}? Escolha uma opção 👇`;
  const buttons = sizes.slice(0, 3).map((s) => ({ id: `size_${s}`, title: s }));
  await wa.sendButtons(phone, m, buttons);
  await chatMemory.push(customer.id, "bot", m);
}

// ── ASK_SIZE ──────────────────────────────────────────────────
async function handleAskSize(wa, cw, phone, text, session, customer, tenant) {
  const sizes = session.sizeOptions || [];
  let chosen = null;
  if (text?.startsWith("size_")) {
    chosen = text.replace("size_", "");
  } else if (sizes.some((s) => text?.toLowerCase().includes(s.toLowerCase()))) {
    chosen = sizes.find((s) => text?.toLowerCase().includes(s.toLowerCase()));
  }

  if (!chosen && sizes.length) {
    const m = `Qual tamanho? Escolha uma opção 👇`;
    await wa.sendButtons(
      phone,
      m,
      sizes.slice(0, 3).map((s) => ({ id: `size_${s}`, title: s })),
    );
    return;
  }

  session.chosenSize = chosen || sizes[0];
  session.step = "ORDERING";
  session.orderHistory = [];

  metaCapi.trackViewContent({ customer, tenantName: tenant.name }).catch(() => {});

  const productType = session.productType || "pizza";
  const isVip = (customer.visitCount || 0) > 0;
  const last = customer.lastOrderSummary;

  const m =
    isVip && last
      ? `Me diz o sabor 🍕\n_(da última vez: ${last})_\n\nQuer o mesmo ou vai mudar?`
      : productType === "lasanha"
        ? `Qual sabor de lasanha? 🍝`
        : `Me diz o sabor da pizza 🍕\n_(ou meia a meia: ex: meia Calabresa meia Frango)_`;

  await wa.sendText(phone, m);
  await chatMemory.push(customer.id, "bot", m);
}

// ── ORDERING ──────────────────────────────────────────────────
async function handleOrdering(wa, cw, phone, text, session, customer, tenant) {
  session.orderHistory.push({ role: "customer", text });

  const catalog =
    session.filteredCatalog &&
    (session.filteredCatalog?.categories?.length || session.filteredCatalog?.sections?.length)
      ? session.filteredCatalog
      : session.catalog;
  const sizeHint = session.chosenSize ? `Tamanho já escolhido: ${session.chosenSize}. ` : "";

  const result = await ai.chatOrder({
    history: session.orderHistory,
    catalog,
    customerName: customer.name,
    lastOrder: customer.lastOrderSummary,
    storeName: tenant.name || "Pappi Pizza",
    city: tenant.city || "Campinas",
    isVip: (customer.visitCount || 0) > 0,
    customer: { lastInteraction: customer.lastInteraction, visitCount: customer.visitCount || 0 },
    productType: session.productType,
    chosenSize: session.chosenSize,
    sizeHint,
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
    const previsao =
      session.fulfillment === "takeout" ? "30 a 40 min" : "60 min";
    m = `✅ *Pedido #${orderNum} confirmado!*\n\n${cartSummary(session.cart)}\n💳 ${session.paymentMethodName}${addrLine}\n⏱️ Previsão: ${previsao}\n\nObrigado! 🍕`;
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
// waMessageId opcional: usado para check azul e deduplicação em recovery (append)
async function saveBaileysMessage(phone, text, tenantId, role = "assistant", waMessageId = null) {
  try {
    const prisma = require("../lib/db");
    const PhoneNormalizer = require("../normalizers/PhoneNormalizer");
    const normalizedPhone = PhoneNormalizer.normalize(phone) || phone;

    const customer = await prisma.customer.findUnique({
      where: { tenantId_phone: { tenantId, phone: normalizedPhone } },
    });
    if (customer) {
      const sender = role === "customer" ? null : "WhatsApp Auxiliar";
      await chatMemory.push(customer.id, role, text, sender, null, "text", waMessageId);
    } else {
      console.warn(`[BaileysMsg] Cliente não encontrado: ${normalizedPhone} (tenant: ${tenantId})`);
    }
  } catch (err) {
    console.error("[Bot] Erro ao salvar msg Baileys:", err.message);
  }
}

module.exports = { handle, saveBaileysMessage };
