// src/routes/bot.handler.js
// CORREÇÕES:
//   - Mutex por usuário evita race condition em webhooks simultâneos
//   - Endereço confirmado é persistido no Customer (touchInteraction)
//   - Falha no CW gera alerta via Baileys para o operador
//   - Usa singleton do PrismaClient via serviços

const { randomUUID } = require("crypto");
const ENV = require("../config/env");
const prisma = require("../lib/db");
const logger = require("../lib/logger");
const { getClients } = require("../services/tenant.service");
const { map: mapPayment, listFormatted: listPayments } = require("../mappers/PaymentMapper");
const { round2, calculate } = require("../calculators/OrderCalculator");
const AddressNormalizer = require("../normalizers/AddressNormalizer");
const PhoneNormalizer = require("../normalizers/PhoneNormalizer");
const ai = require("../services/ai.service");
const chatMemory = require("../services/chat-memory.service");
const Maps = require("../services/maps.service");
const sessionService = require("../services/session.service");
const customerService = require("../services/customer.service");
const { learningKeyFromCustomer, waCloudDestination } = customerService;
const metaCapi = require("../services/meta-capi.service");
const { routeByTime } = require("../services/time-routing.service");
const aviseAbertura = require("../services/avise-abertura.service");
const { needsDeescalation, detectHumanRequest } = require("../services/deescalation.service");
const inboxTriage = require("../services/inbox-triage.service");
const orderIntake = require("../services/order-intake.service");
const aiOrchestrator = require("../services/ai-orchestrator.service");
const orderPixDbCompat = require("../lib/order-pix-db-compat");
const cartPricing = require("../services/cart-pricing.service");
const orderService = require("../services/order.service");
const baileys = require("../services/baileys.service");
const socketService = require("../services/socket.service");
const interPix = require("../services/inter-pix.service");
const botLearning = require("../services/bot-learning.service");
const audioSynthesis = require("../services/audio-synthesis.service");
const GREETING_COOLDOWN_MS = 5 * 60 * 1000;
const MENU_COOLDOWN_MS = 2 * 60 * 1000;
const CW_ORDER_LINK = "https://app.cardapioweb.com/pappi_pizza?s=atende";
const DELIVERY_SOFT_RADIUS_KM = Number(process.env.DELIVERY_SOFT_RADIUS_KM || 8);

function extractCepDigitsFromString(s) {
  const m = String(s || "").match(/\b(\d{5})-?(\d{3})\b/);
  return m ? m[1] + m[2] : "";
}

/** Preenche CEP, rua/nº/bairro/cidade a partir do texto tipo Google e geocodifica coords se faltar. */
function parseBrazilianFormattedAddressLine(formatted) {
  const out = {};
  const f = String(formatted || "").trim();
  if (!f) return out;
  const cep = extractCepDigitsFromString(f);
  if (cep.length === 8) out.zipCode = `${cep.slice(0, 5)}-${cep.slice(5)}`;
  const noCountry = f.replace(/,\s*Brazil\s*$/i, "").trim();
  const parts = noCountry.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) {
    const first = parts[0];
    const second = parts[1];
    const mNum = second.match(/^(\d+)\s*[-–]\s*(.+)$/);
    if (mNum) {
      out.street = first;
      out.number = mNum[1];
      out.neighborhood = mNum[2];
    } else if (/^\d{1,8}$/.test(second)) {
      out.street = first;
      out.number = second;
    }
    const cityState = parts[2]?.match(/^(.+?)\s*-\s*([A-Z]{2})$/);
    if (cityState) {
      out.city = cityState[1].trim();
      out.state = cityState[2];
    }
  }
  return out;
}

async function enrichAddressObjectForDelivery(a, tenant, cw) {
  if (!a) return;
  const z = String(a.zipCode || "").replace(/\D/g, "");
  if (z.length !== 8 && a.formatted) {
    const cep = extractCepDigitsFromString(a.formatted);
    if (cep.length === 8) a.zipCode = `${cep.slice(0, 5)}-${cep.slice(5)}`;
  }
  const needParts =
    !(a.street || "").trim() ||
    !(a.number || "").trim() ||
    !(a.neighborhood || "").trim() ||
    !(a.city || "").trim() ||
    !(a.state || "").trim();
  if (needParts && a.formatted) {
    const p = parseBrazilianFormattedAddressLine(a.formatted);
    if (!(a.street || "").trim() && p.street) a.street = p.street;
    if (!(a.number || "").trim() && p.number) a.number = p.number;
    if (!(a.neighborhood || "").trim() && p.neighborhood) a.neighborhood = p.neighborhood;
    if (!(a.city || "").trim() && p.city) a.city = p.city;
    if (!(a.state || "").trim() && p.state) a.state = p.state;
    if (!(a.zipCode || "").trim() && p.zipCode) a.zipCode = p.zipCode;
  }
  const hasCoords =
    Number.isFinite(a.lat) &&
    Number.isFinite(a.lng) &&
    Math.abs(a.lat) > 1e-5 &&
    Math.abs(a.lng) > 1e-5;
  if (!hasCoords && a.formatted) {
    try {
      const geo = await Maps.quote(a.formatted, cw);
      if (geo) {
        a.lat = geo.lat;
        a.lng = geo.lng;
        if (geo.formatted_address) a.formatted = geo.formatted_address;
      }
    } catch {}
  }
}

function extractDeliveryFeeFromResult(result) {
  if (Number.isFinite(result)) return Number(result);
  if (typeof result === "string") {
    const n = Number(String(result).replace(/[^\d,.-]/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  if (!result || typeof result !== "object") return null;
  const nested = result.data && typeof result.data === "object" ? result.data : {};
  const candidates = [
    result.delivery_fee,
    result.fee,
    result.value,
    result.amount,
    result.total_fee,
    result.price,
    nested.delivery_fee,
    nested.fee,
    nested.value,
    nested.amount,
    nested.total_fee,
    nested.price,
  ];
  for (const v of candidates) {
    if (Number.isFinite(v)) return Number(v);
    if (typeof v === "string") {
      const n = Number(String(v).replace(/[^\d,.-]/g, "").replace(",", "."));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function indicatesOutOfRange(result) {
  if (!result || typeof result !== "object") return false;
  const nested = result.data && typeof result.data === "object" ? result.data : {};
  const status = String(result.status || result.code || result.reason || nested.status || nested.code || "")
    .toLowerCase()
    .trim();
  const msg = String(result.message || result.error || result.detail || nested.message || nested.error || nested.detail || "")
    .toLowerCase()
    .trim();
  const errors = Array.isArray(result.errors) ? result.errors.join(" ").toLowerCase() : "";
  if (result.is_serviceable === false || nested.is_serviceable === false) return true;
  if (status.includes("out_of_range") || status.includes("outside") || status.includes("unserviceable")) return true;
  if (msg.includes("fora da area") || msg.includes("fora da área") || msg.includes("nao atend") || msg.includes("não atend")) return true;
  if (errors.includes("fora da area") || errors.includes("fora da área")) return true;
  return false;
}

function hasSoftDeliveryCoverage(geo) {
  if (!geo || typeof geo !== "object") return false;
  return Number.isFinite(geo.km) && geo.km <= DELIVERY_SOFT_RADIUS_KM;
}

async function sendAddressReviewPrompt(wa, phone, customer, session) {
  const m =
    "Não consegui validar a taxa desse endereço agora, mas vamos seguir 😊\n" +
    "Se quiser agilizar, me manda também o CEP ou a localização 📍.";
  session.step = "ADDRESS";
  await wa.sendText(phone, m);
  await chatMemory.push(customer.id, "bot", m);
}

async function sendOutOfRangePrompt(wa, phone, customer, session) {
  const m = "Infelizmente este endereço está fora da nossa área de entrega 😔. Deseja informar outro endereço ou trocar para Retirada na loja?";
  session.step = "DELIVERY_COVERAGE_DECISION";
  await wa.sendButtons(phone, m, [
    { id: "oor_change_addr", title: "📍 Outro endereço" },
    { id: "oor_takeout", title: "🏪 Retirada" },
  ]);
  await chatMemory.push(customer.id, "bot", m);
}

// ── FASE 3: handlers dedicados (inbox real) ────────────────────
async function handleHumanHandoff({ tenant, wa, customer, phone, sessionKey, session, message, clear = true } = {}) {
  const sk = sessionKey != null ? sessionKey : phone;
  await customerService.setHandoff(customer.id, true);
  await wa.sendText(phone, message || "Vou chamar um atendente pra te ajudar. Um momento! 👨‍💼");
  await chatMemory.push(customer.id, "bot", message || "Vou chamar um atendente pra te ajudar. Um momento! 👨‍💼");
  if (clear) await clearSession(tenant.id, sk);
  socketService.emitQueueUpdate();
}

async function handleStatusFlow({ wa, phone, customer, tenant, session } = {}) {
  // Reaproveita o handler existente (já consulta pedido e responde status)
  await handleStatusQuery(wa, phone, customer, tenant, session);
}

async function handleComplaintFlow({ tenant, wa, customer, phone, sessionKey, session, text } = {}) {
  const sk = sessionKey != null ? sessionKey : phone;
  session.mode = "COMPLAINT";
  await saveSession(tenant.id, sk, session);
  // Tenta localizar último pedido para dar contexto ao atendente
  try {
    const lastOrder = await prisma.order.findFirst({
      where: { customerId: customer.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, createdAt: true },
    });
    const ref = lastOrder?.id ? lastOrder.id.slice(-6).toUpperCase() : null;
    const m =
      "Sinto muito por isso. Vou chamar um atendente pra resolver com você agora. 👨‍💼" +
      (ref ? `\n\n📦 Referência: #${ref}` : "");
    await handleHumanHandoff({ tenant, wa, customer, phone, sessionKey: sk, session, message: m, clear: false });
    baileys
      .notify(
        `🚨 *Reclamação*\n👤 ${customer.name || phone}\n📞 ${phone}\n` +
          (ref ? `📦 Pedido: #${ref}\n` : "") +
          `💬 ${String(text || "").slice(0, 200)}`,
      )
      .catch(() => {});
  } catch {
    await handleHumanHandoff({
      tenant,
      wa,
      customer,
      phone,
      sessionKey: sk,
      session,
      message: "Sinto muito por isso. Vou chamar um atendente pra resolver com você agora. 👨‍💼",
      clear: false,
    });
  }
}

async function handleFaqFlow({ tenant, wa, customer, phone, sessionKey, session, text, cw } = {}) {
  const sk = sessionKey != null ? sessionKey : phone;
  session.mode = "FAQ";
  await saveSession(tenant.id, sk, session);
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  // Cardápio
  if (t.includes("cardapio") || t.includes("cardápio") || t.includes("menu")) {
    const merchant = await cw.getMerchant().catch(() => null);
    const url = merchant?.url || merchant?.website || "";
    const m = url ? `📱 Cardápio: ${url}` : "Me diga o que deseja e eu te ajudo a montar o pedido! 😊";
    await wa.sendText(phone, m);
    await chatMemory.push(customer.id, "bot", m);
    return;
  }

  // Formas de pagamento
  if (t.includes("pagamento") || t.includes("pix") || t.includes("cartao") || t.includes("cartão") || t.includes("dinheiro")) {
    const m = `💳 Formas de pagamento:\n\n${listPayments(tenant.id)}`;
    await wa.sendText(phone, m);
    await chatMemory.push(customer.id, "bot", m);
    return;
  }

  // Taxa / entrega (resposta informativa sem prometer valor exato sem endereço)
  if (t.includes("taxa") || t.includes("entrega") || t.includes("delivery")) {
    const m =
      "🛵 Fazemos entrega sim.\n\nA *taxa* depende do endereço (CEP ou localização 📍). Se quiser, me envie seu CEP que eu calculo certinho.";
    await wa.sendText(phone, m);
    await chatMemory.push(customer.id, "bot", m);
    return;
  }

  // Horário (usa time-routing para responder “aberto/fechado” sem entrar no funil)
  if (t.includes("horario") || t.includes("horário") || t.includes("aberto") || t.includes("fecha") || t.includes("funciona")) {
    const m = await buildStoreHoursMessage(cw);
    await wa.sendText(phone, m);
    await chatMemory.push(customer.id, "bot", m);
    return;
  }

  // Fallback FAQ gentil
  const m = `Claro! Me diz sua dúvida em uma frase (ex.: taxa, horário, pagamento, sabores, tamanho).\n\nOu, se preferir, peça direto pelo link: ${CW_ORDER_LINK}`;
  await wa.sendText(phone, m);
  await chatMemory.push(customer.id, "bot", m);
}

function formatMerchantHours(openingHours) {
  if (!openingHours || typeof openingHours !== "object") return [];
  const labels = {
    sunday: "Domingo",
    monday: "Segunda",
    tuesday: "Terça",
    wednesday: "Quarta",
    thursday: "Quinta",
    friday: "Sexta",
    saturday: "Sábado",
  };
  return Object.entries(labels).map(([key, label]) => {
    const intervals = Array.isArray(openingHours[key]) ? openingHours[key] : [];
    const text = intervals.length ? intervals.map((pair) => Array.isArray(pair) ? `${pair[0]} às ${pair[1]}` : String(pair)).join(" · ") : "Fechado";
    return `• ${label}: ${text}`;
  });
}

async function buildStoreHoursMessage(cw) {
  const slot = routeByTime();
  const merchant = await cw.getMerchant().catch(() => null);
  const hours = formatMerchantHours(merchant?.opening_hours);
  const header = slot?.isOpen ? "✅ Estamos abertos agora." : (slot?.message || "No momento estamos fechados.");
  return hours.length ? header + "\n\n🕒 *Horários de atendimento*\n" + hours.join("\n") : header;
}


async function handleDriverFlow({ tenant, wa, customer, phone, sessionKey, session, text } = {}) {
  const sk = sessionKey != null ? sessionKey : phone;
  session.mode = "DRIVER";
  await saveSession(tenant.id, sk, session);
  const m = "Recebido ✅ Obrigado! Se puder, me passe o número do pedido (#XXXXXX) ou o nome/telefone do cliente.";
  await wa.sendText(phone, m);
  await chatMemory.push(customer.id, "bot", m);
  // Notifica interno (sem entrar no funil comercial)
  try {
    baileys.notify(`🚗 *Operação/Motoboy*\n📞 ${phone}\n💬 ${String(text || "").slice(0, 200)}`).catch(() => {});
  } catch {}
}

async function handleFallbackTriage({ tenant, wa, customer, phone, sessionKey, session } = {}) {
  const sk = sessionKey != null ? sessionKey : phone;
  const now = Date.now();
  const lastAt = session._lastTriagePromptAt || 0;
  if (now - lastAt < 60 * 1000) return; // anti-repetição
  session._lastTriagePromptAt = now;
  const m = `Tô por aqui 😊 Você pode me mandar seu pedido do jeito que vier na cabeça, perguntar horário, cardápio ou status.\n\nPedido rápido: ${CW_ORDER_LINK}`;
  await wa.sendText(phone, m);
  await chatMemory.push(customer.id, "bot", m);
  await saveSession(tenant.id, sk, session);
}

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

function normalizeText(input) {
  return String(input || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function extractAddressNumber(text) {
  const m = String(text || "").match(/\b(\d{1,6}[a-zA-Z]?)\b/);
  return m ? m[1] : "";
}

function parseLooseAddressFromText(text, tenant) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const n = extractAddressNumber(raw);
  let street = raw;
  if (n) {
    street = raw
      .replace(new RegExp(`\\b${String(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`), "")
      .replace(/[,\-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (!street || street.length < 4) return null;
  return {
    street,
    number: n || "",
    neighborhood: "",
    city: tenant?.city || "",
    state: "SP",
    zipCode: "",
    complement: "",
    formatted: raw,
  };
}

async function resolveAddressFromFreeText(input, tenant, cw) {
  const cleaned = String(input || "").trim();
  if (!cleaned) return { addr: null, confidence: "low", geo: null };

  let parsed = null;
  try {
    parsed = await ai.extractAddress(cleaned, tenant.city || "Campinas");
  } catch {}
  if (!parsed) {
    const ext = AddressNormalizer.fromText(cleaned);
    const res = AddressNormalizer.normalize({ ...ext, city: tenant.city || "" });
    if (res.ok) parsed = res.address;
  }
  if (!parsed) parsed = parseLooseAddressFromText(cleaned, tenant);

  let geo = null;
  try {
    geo = await Maps.geocode(`${cleaned}, ${tenant.city || "Campinas"}`);
  } catch {}

  if (!geo) {
    if (!parsed) return { addr: null, confidence: "low", geo: null };
    return { addr: parsed, confidence: parsed?.street ? "medium" : "low", geo: null };
  }

  const extGeo = AddressNormalizer.fromText(geo.formatted_address || cleaned);
  const normGeo = AddressNormalizer.normalize({ ...extGeo, city: tenant.city || "" });
  const geoAddr = normGeo?.ok ? normGeo.address : {};

  const merged = {
    street: parsed?.street || geoAddr?.street || "",
    number: parsed?.number || geoAddr?.number || extractAddressNumber(cleaned),
    neighborhood: parsed?.neighborhood || geoAddr?.neighborhood || "",
    city: parsed?.city || geoAddr?.city || tenant.city || "",
    state: parsed?.state || geoAddr?.state || "SP",
    zipCode: parsed?.zipCode || geoAddr?.zipCode || "",
    complement: parsed?.complement || "",
    formatted: geo.formatted_address || cleaned,
    lat: geo.lat,
    lng: geo.lng,
  };

  const confidence = merged.street && merged.number ? "high" : merged.street ? "medium" : "low";
  return { addr: merged, confidence, geo };
}

function resolveCatalogSizeFromText(text, sizeOptions = []) {
  const raw = String(text || "").trim();
  const norm = normalizeText(raw);
  if (!norm || !sizeOptions.length) return { chosen: null, remainder: raw };

  if (raw.startsWith("size_")) {
    const direct = raw.replace("size_", "");
    const exact = sizeOptions.find((s) => normalizeText(s) === normalizeText(direct));
    if (exact) return { chosen: exact, remainder: "" };
  }

  const normalizedOptions = sizeOptions.map((opt) => ({
    original: opt,
    norm: normalizeText(opt),
    number: (String(opt).match(/\b(\d{1,2})\b/) || [])[1] || "",
  }));

  let chosen = normalizedOptions.find((o) => norm.includes(o.norm))?.original || null;
  let matchedToken = chosen ? normalizeText(chosen) : "";

  if (!chosen) {
    const mNum = norm.match(/\b(?:de\s+)?(\d{1,2})\b/);
    const num = mNum?.[1] || "";
    if (num) {
      const byNum = normalizedOptions.find((o) => o.number === num);
      if (byNum) {
        chosen = byNum.original;
        matchedToken = num;
      } else {
        // Catálogo sem número explícito (ex.: Broto/Grande/Gigante): mapeia por faixa de pedaços.
        const value = Number(num);
        const bySmall = normalizedOptions.find((o) => o.norm.includes("brot") || o.norm.includes("pequen") || o.norm.includes("mini"));
        const byLarge = normalizedOptions.find((o) => o.norm.includes("grand") || o.norm.includes("famil"));
        const byGigante = normalizedOptions.find((o) => o.norm.includes("gigant"));
        if (Number.isFinite(value)) {
          // Pappi: Broto=4p, Grande=8p, Gigante=16p
          if (value <= 6 && bySmall) chosen = bySmall.original;
          else if (value <= 12 && byLarge) chosen = byLarge.original;
          else if (byGigante) chosen = byGigante.original;
          else if (byLarge) chosen = byLarge.original;
          if (chosen) matchedToken = num;
        }
      }
    }
  }

  if (!chosen) {
    const aliasRules = [
      { rx: /\bbrot(?:o|inho)?\b/, keys: ["brot", "pequen", "mini"] },
      { rx: /\bgigant(?:e|ao)?\b/, keys: ["gigant"] },
      { rx: /\bgrand(?:e|ao)?\b/, keys: ["grand", "famil"] },
    ];
    for (const rule of aliasRules) {
      if (!rule.rx.test(norm)) continue;
      const found = normalizedOptions.find((o) => rule.keys.some((k) => o.norm.includes(k)));
      if (found) {
        chosen = found.original;
        matchedToken = (norm.match(rule.rx) || [""])[0];
        break;
      }
    }
  }

  if (!chosen) return { chosen: null, remainder: raw };

  const remainder = norm
    .replace(new RegExp(`\\b${matchedToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), " ")
    .replace(/\b(de|pizza|lasanha|tamanho|quero|uma|um|a|o)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { chosen, remainder };
}

function applyOrchestratorStepOverride(session, orchestration, text) {
  if (!session || !orchestration || typeof orchestration !== "object") return false;

  const validSteps = new Set([
    "MENU",
    "CHOOSE_PRODUCT_TYPE",
    "ASK_NAME",
    "FULFILLMENT",
    "ADDRESS",
    "ADDRESS_NUMBER",
    "ADDRESS_CONFIRM",
    "ASK_SIZE",
    "ORDERING",
    "PAYMENT",
    "CONFIRM",
    "DEESCALATION",
  ]);

  const normalizeStep = (s) => String(s || "").trim().toUpperCase();
  const direct = normalizeStep(orchestration.overrideStep || orchestration.nextStep || orchestration.step);
  if (direct && validSteps.has(direct) && direct !== session.step) {
    session.step = direct;
    return true;
  }

  const action = normalizeStep(orchestration.action || orchestration.intent || orchestration.decision);
  if (action === "CHANGE_ORDER" || action === "RESTART_ORDER" || action === "MODIFY_ORDER") {
    if (session.step !== "ORDERING") {
      session.step = "ORDERING";
      return true;
    }
  }

  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const asksChange =
    /\bmudar\b/.test(t) && /\bpedido\b/.test(t) ||
    /\balterar\b/.test(t) && /\bpedido\b/.test(t) ||
    /\btrocar\b/.test(t) && /\bpedido\b/.test(t);
  if (asksChange && ["PAYMENT", "CONFIRM"].includes(String(session.step || ""))) {
    session.step = "ORDERING";
    return true;
  }

  return false;
}

// ── Ponto de entrada — com mutex por usuário ──────────────────
async function handle({ tenant, wa, customer, text, phone, sessionKey, timer, isAudioInput = false }) {
  const sk = sessionKey != null ? sessionKey : sessionService.discriminatorFromCustomer(customer);
  const lockKey = `${tenant.id}:${sk}`;

  // CORREÇÃO: mutex garante que dois webhooks simultâneos do mesmo usuário
  // não processem em paralelo, evitando race condition na sessão
  return sessionService.withLock(lockKey, async () => {
    return _handle({ tenant, wa, customer, text, phone, sessionKey: sk, timer, isAudioInput });
  });
}

async function _handle({ tenant, wa, customer, text, phone, sessionKey, timer, isAudioInput = false }) {
  const session = await getSession(tenant.id, sessionKey);
  session.lastInputWasAudio = !!isAudioInput;
  if (isAudioInput) session.prefersAudio = true;
  if (typeof session.prefersAudio !== "boolean") session.prefersAudio = false;
  timer?.mark("session");
  const { cw } = await getClients(tenant.id);
  timer?.mark("clients");

  // Resultados locais (evita vazamento de escopo/global e permite orquestrador usar sempre)
  let triageResult = null;
  let intakeResult = null;

  // FASE 1: mode (tipo de conversa) separado do step (etapa interna)
  if (!session.mode) session.mode = "TRIAGE";

  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  // Atendente/humano: handoff imediato
  if (detectHumanRequest(text)) {
    session.mode = "HUMAN";
    await saveSession(tenant.id, sessionKey, session);
    await handleHumanHandoff({ tenant, wa, customer, phone, sessionKey, session });
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
    await saveSession(tenant.id, sessionKey, session);
    return;
  }

  // Resposta aos botões de deescalation
  if (session.step === "DEESCALATION") {
    if (text === "HELP_HUMAN" || t.includes("atendente")) {
      session.mode = "HUMAN";
      await saveSession(tenant.id, sessionKey, session);
      await handleHumanHandoff({ tenant, wa, customer, phone, sessionKey, session });
      return;
    }
    // "Continua" vira "continua" após normalizar — não contém "continuar" como substring
    const wantsContinueBot =
      text === "HELP_BOT" || t.includes("continua") || t.includes("continuar");
    if (wantsContinueBot) {
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
      if (prev === "ORDERING") m = "Beleza! Me fala seu pedido do jeito que preferir 🍕";
      else if (prev === "ASK_SIZE") m = `Perfeito. Qual tamanho de ${session.productType === "lasanha" ? "lasanha" : "pizza"}?`;
      else if (prev === "FULFILLMENT") m = "Beleza. Vai ser entrega ou retirada?";
      else m = "Beleza. Me fala o que você quer pedir que eu sigo com você por aqui.";
      await wa.sendText(phone, m);
      await chatMemory.push(customer.id, "bot", m);
      await saveSession(tenant.id, sessionKey, session);
      return;
    }
    if (text === "FULFILLMENT_RETIRADA" || t.includes("retirada")) {
      session.fulfillment = "takeout";
      delete session._beforeDeescalationStep;
      await startOrdering(wa, cw, phone, session, customer, tenant);
      await saveSession(tenant.id, sessionKey, session);
      return;
    }
    if (text === "delivery" || t.includes("entrega")) {
      delete session._beforeDeescalationStep;
      await handleFulfillment(wa, cw, phone, text, t, session, customer, tenant);
      await saveSession(tenant.id, sessionKey, session);
      return;
    }
    // Resposta não reconhecida — reenvia os botões
    await wa.sendButtons(phone, "Escolha uma opção abaixo 👇", [
      { id: "HELP_HUMAN", title: "👩‍💼 Atendente" },
      { id: "HELP_BOT", title: "✅ Continuar" },
      { id: "FULFILLMENT_RETIRADA", title: "🏪 Retirada" },
    ]);
    await saveSession(tenant.id, sessionKey, session);
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
    session.mode = "STATUS";
    await saveSession(tenant.id, sessionKey, session);
    await handleStatusFlow({ wa, phone, customer, tenant, session });
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
      await aviseAbertura.addToAberturaList(tenant.id, customer);
      const m =
        "Perfeito! Assim que o forno atingir a temperatura ideal e abrirmos oficialmente, você será o primeiro a receber um toque aqui no Zap! 🍕🔥";
      await wa.sendText(phone, m);
      await chatMemory.push(customer.id, "bot", m);
      await clearSession(tenant.id, sessionKey);
      return;
    }
    // Enviar mensagem do slot — com botão em Tarde e Pré-Abertura
    if (timeSlot.hasAviseButton) {
      await wa.sendButtons(phone, timeSlot.message, [{ id: "AVISE_ABERTURA", title: "🔔 Me avise quando abrir" }]);
    } else {
      await wa.sendText(phone, timeSlot.message);
    }
    await chatMemory.push(customer.id, "bot", timeSlot.message);
    await clearSession(tenant.id, sessionKey);
    return;
  }
  if (!storeOpen && closedAsLead) {
    session.isLeadOrder = true;
  }

  // ── TRIAGEM ANTES DO FUNIL ──────────────────────────────────
  // Evita entrar cedo em "pizza ou lasanha" quando for status/reclamação/humano/etc.
  try {
    triageResult = inboxTriage.triage({ text, session });
    const now = Date.now();

    if (triageResult.intent === "HUMAN") {
      session.mode = "HUMAN";
      await saveSession(tenant.id, sessionKey, session);
      await handleHumanHandoff({ tenant, wa, customer, phone, sessionKey, session });
      return;
    }
    if (triageResult.intent === "ORDER_STATUS") {
      session.mode = "STATUS";
      await saveSession(tenant.id, sessionKey, session);
      await handleStatusFlow({ wa, phone, customer, tenant, session });
      return;
    }
    if (triageResult.intent === "MENU") {
      await handleFaqFlow({ tenant, wa, customer, phone, sessionKey, session, text, cw });
      return;
    }
    if (triageResult.intent === "COMPLAINT") {
      await handleComplaintFlow({ tenant, wa, customer, phone, session, text });
      return;
    }
    if (triageResult.intent === "DRIVER") {
      await handleDriverFlow({ tenant, wa, customer, phone, sessionKey, session, text });
      return;
    }

    // Se está em triagem e a mensagem não parece pedido, evita disparar o funil.
    const earlySteps = ["MENU", "CHOOSE_PRODUCT_TYPE", "FULFILLMENT"];
    if (session.mode === "TRIAGE" && earlySteps.includes(session.step) && triageResult.intent === "OTHER") {
      if (!triageResult.shouldWaitMore) {
        await handleFallbackTriage({ tenant, wa, customer, phone, sessionKey, session });
        return;
      } // se shouldWaitMore, fica silencioso (buffer já consolida)
    }

    if (triageResult.intent === "NEW_ORDER") session.mode = "ORDER";
  } catch {
    // triagem falhou → segue fluxo atual
  }

  // ── FASE 2: Intake de pedido (pré-preenche sessão; não muda integração CW) ──
  try {
    if (session.mode === "ORDER") {
      // Garante catálogo/tamanhos em sessão para detectar size no texto
      if (!session.catalog || !session.sizeOptions) {
        try {
          const rawCatalog = await cw.getCatalog();
          const fullCatalog = rawCatalog?.catalog || rawCatalog?.data || rawCatalog;
          if (fullCatalog) {
            session.catalog = fullCatalog;
            const productType = session.productType || "pizza";
            const { catalog: filteredCatalog, sizes } = filterCatalogByProductType(fullCatalog, productType);
            session.filteredCatalog = filteredCatalog;
            session.sizeOptions = sizes;
          }
        } catch {}
      }

      intakeResult = orderIntake.intake({ text, sizeOptions: session.sizeOptions || [] });
      const isPriceQuestion = /\b(quanto e|quanto custa|qual o valor|qual o preco|valor d)\b/i.test(t);
      if (isPriceQuestion && intakeResult?.hasItems) {
        session.step = "ORDERING";
        session.orderHistory = session.orderHistory || [];
        if (!session.orderHistory.length) session.orderHistory.push({ role: "customer", text });
        await handleOrdering(wa, cw, phone, text, session, customer, tenant, timer);
        await saveSession(tenant.id, sessionKey, session);
        return;
      }
      if (intakeResult?.isOrder && !session.initialIntakeText) session.initialIntakeText = text;
      if (intakeResult?.paymentMethod && !session.paymentMethodName) {
        const mapped = mapPayment(tenant.id, intakeResult.paymentMethod);
        if (mapped.matched) {
          session.paymentMethodId = mapped.id;
          session.paymentMethodName = mapped.name;
        }
      }
      if (intakeResult?.productType && !session.productType) session.productType = intakeResult.productType;
      if (intakeResult?.fulfillment && !session.fulfillment) session.fulfillment = intakeResult.fulfillment;
      if (intakeResult?.size && !session.chosenSize) session.chosenSize = intakeResult.size;

      // Fast-forward agressivo no início do funil:
      // mensagem completa (tipo+tamanho+fulfillment) não deve cair em "pizza ou lasanha" / "qual tamanho?".
      const intakeLooksComplete = !!(intakeResult?.productType && intakeResult?.size && intakeResult?.fulfillment);
      const earlyFunnelSteps = ["MENU", "CHOOSE_PRODUCT_TYPE", "FULFILLMENT", "ASK_SIZE"];
      if (intakeLooksComplete && earlyFunnelSteps.includes(session.step)) {
        if (intakeResult.fulfillment === "delivery") {
          session.step = "ADDRESS";
          if (intakeResult.address) {
            await handleAddress(wa, cw, phone, text, session, customer, tenant, timer);
          } else {
            const m = "🛵 Perfeito! Agora me manda o endereço (Rua + Número + Bairro) ou o CEP 📍";
            await wa.sendText(phone, m);
            await chatMemory.push(customer.id, "bot", m);
          }
          await saveSession(tenant.id, sessionKey, session);
          return;
        }
        // Retirada: pula prompts iniciais e tenta ir direto para ORDERING
        await startOrdering(wa, cw, phone, session, customer, tenant);
        await saveSession(tenant.id, sessionKey, session);
        if (session.step === "ORDERING") {
          await handleOrdering(wa, cw, phone, text, session, customer, tenant, timer);
          await saveSession(tenant.id, sessionKey, session);
        }
        return;
      }

      if (!intakeLooksComplete && intakeResult?.productType && ["MENU", "CHOOSE_PRODUCT_TYPE"].includes(session.step)) {
        session.step = "FULFILLMENT";
        const msg = "Perfeito. Vai ser entrega ou retirada?";
        await wa.sendButtons(phone, msg, [
          { id: "delivery", title: "🚚 Entrega" },
          { id: "takeout", title: "🏪 Retirada" },
        ]);
        await chatMemory.push(customer.id, "bot", msg);
        await saveSession(tenant.id, sessionKey, session);
        return;
      }

      // Se já identificou entrega/retirada no texto, reaproveita o handler atual (endereço / startOrdering)
      if (intakeResult?.fulfillment && session.step === "FULFILLMENT") {
        await handleFulfillment(
          wa,
          cw,
          phone,
          intakeResult.fulfillment === "delivery" ? "delivery" : "takeout",
          t,
          session,
          customer,
          tenant,
        );
        await saveSession(tenant.id, sessionKey, session);
        return;
      }

      // Se já estamos perguntando tamanho e ele veio no texto, não repete pergunta
      if (session.step === "ASK_SIZE" && intakeResult?.size) {
        // Mantém o texto original para aproveitar sabor/complementos na mesma mensagem.
        await handleAskSize(wa, cw, phone, text, session, customer, tenant);
        await saveSession(tenant.id, sessionKey, session);
        return;
      }

      // Se a mensagem já tem itens (pedido veio “de uma vez”), pula o prompt genérico e deixa o fluxo vencedor interpretar.
      // IMPORTANTE: quando já estamos em `ASK_SIZE`, não dispare `startOrdering()`,
      // para não re-perguntar “Qual tamanho?” (o próprio `handleAskSize()` já resolve tamanho+resto na mesma mensagem).
      const early = ["MENU", "CHOOSE_PRODUCT_TYPE", "FULFILLMENT"];
      if (intakeResult?.isOrder && intakeResult?.confidence >= 0.7 && intakeResult?.missing && intakeResult.missing.length <= 3) {
        // Se ainda não entrou em ordering, tenta iniciar (sem repetir ASK_SIZE se chosenSize já foi detectado)
        if (session.fulfillment && early.includes(session.step)) {
          await startOrdering(wa, cw, phone, session, customer, tenant);
          await saveSession(tenant.id, sessionKey, session);
          // Se já caiu em ORDERING, manda o texto direto para o interpretador existente (AI+catálogo)
          if (session.step === "ORDERING" && intakeResult?.isOrder) {
            await handleOrdering(wa, cw, phone, text, session, customer, tenant, timer);
            await saveSession(tenant.id, sessionKey, session);
            return;
          }
          return;
        }
      }
    }
  } catch {
    // intake falhou → segue fluxo atual
  }

  // ── FASE 1: Orquestrador consultivo (não altera CW, preços nem payment_method_id) ──
  try {
    const recent = await chatMemory.get(customer.id);
    const history = (recent || []).slice(-16).map((m) => ({
      role: m.role,
      text: String(m.text || "").slice(0, 500),
      at: m.at,
    }));
    session._orchestration = await aiOrchestrator.decideOrchestration({
      tenantId: tenant.id,
      customer: {
        id: customer.id,
        name: customer.name,
        visitCount: customer.visitCount,
        preferredPayment: customer.preferredPayment,
        handoff: customer.handoff,
      },
      session,
      text,
      history,
      triageResult,
      intakeResult,
    });
  } catch {
    // orquestrador é best-effort
  }

  // Orquestrador pode forçar step em mudanças bruscas de contexto
  // (ex.: cliente decide mudar pedido durante PAYMENT/CONFIRM).
  try {
    applyOrchestratorStepOverride(session, session._orchestration, text);
  } catch {}

  // Comandos PT-BR para iniciar/menu (t já normalizado sem acentos)
  const menuTriggers = ["oi", "ola", "ola!", "menu", "inicio", "comecar", "cardapio", "opa", "e ai", "fala"];
  if (menuTriggers.includes(t)) {
    const prevMenuAt = Number(session?._lastMenuPromptAt || 0);
    await clearSession(tenant.id, sessionKey);
    const fresh = await getSession(tenant.id, sessionKey);
    if (prevMenuAt) fresh._lastMenuPromptAt = prevMenuAt;
    if (!storeOpen && closedAsLead) fresh.isLeadOrder = true;
    await sendGreeting(wa, cw, phone, customer, tenant, fresh, timer);
    await saveSession(tenant.id, sessionKey, fresh);
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

  // Fast path: escolhas óbvias — pula classifyIntent (IA ~1–3s) para resposta instantânea
  // WhatsApp envia o *title* do botão (ex.: "🚚 Entrega"), não só o id — o regex ^entrega$ falhava e a IA
  // classificava como STATUS → mensagem errada de "não encontrei pedido".
  const isProductChoice =
    session.step === "CHOOSE_PRODUCT_TYPE" && /^(pizza|lasanha)$/.test((text || "").trim().toLowerCase());
  const isFulfillmentChoice =
    session.step === "FULFILLMENT" &&
    (t.includes("entrega") ||
      t.includes("retirada") ||
      t.includes("buscar") ||
      t.includes("retirar") ||
      /^(delivery|takeout)$/.test((text || "").trim().toLowerCase()));

  if (
    !isProductChoice &&
    !isFulfillmentChoice &&
    ["MENU", "CHOOSE_PRODUCT_TYPE", "FULFILLMENT"].includes(session.step)
  ) {
    try {
      timer?.mark("pre_classify");
      const intent = await ai.classifyIntent(text);
      timer?.mark("classifyIntent");
      if (intent === "STATUS") {
        session.mode = "STATUS";
        await saveSession(tenant.id, sessionKey, session);
        await handleStatusFlow({ wa, phone, customer, tenant, session });
        return;
      }
      if (intent === "CARDAPIO") {
        await handleFaqFlow({ tenant, wa, customer, phone, sessionKey, session, text, cw });
        return;
      }
      if (intent === "HANDOFF") {
        session.mode = "HUMAN";
        await saveSession(tenant.id, sessionKey, session);
        await handleHumanHandoff({ tenant, wa, customer, phone, sessionKey, session });
        return;
      }
    } catch {}
  }

  switch (session.step) {
    case "MENU":
    case "CHOOSE_PRODUCT_TYPE":
    case "ASK_SIZE":
      if (!session.catalog) {
        try {
          const rawCatalog = await cw.getCatalog();
          session.catalog = rawCatalog?.catalog || rawCatalog?.data || rawCatalog;
          session.filteredCatalog = session.catalog;
        } catch {}
      }
      session.step = "ORDERING";
      session.orderHistory = session.orderHistory || [];
      if (!session.orderHistory.length) session.orderHistory.push({ role: "customer", text });
      await handleOrdering(wa, cw, phone, text, session, customer, tenant, timer);
      break;
    case "ASK_NAME":
      await handleAskName(wa, cw, phone, text, session, customer, tenant, timer);
      break;
    case "FULFILLMENT":
      await handleFulfillment(wa, cw, phone, text, t, session, customer, tenant);
      break;
    case "ADDRESS":
      await handleAddress(wa, cw, phone, text, session, customer, tenant, timer);
      break;
    case "ADDRESS_NUMBER":
      await handleAddressNumber(wa, cw, phone, text, session, customer, tenant);
      break;
    case "ADDRESS_CONFIRM":
      await handleAddressConfirm(wa, cw, phone, text, t, session, customer, tenant);
      break;
    case "DELIVERY_COVERAGE_DECISION":
      await handleDeliveryCoverageDecision(wa, cw, phone, text, t, session, customer, tenant);
      break;
    case "ORDERING":
      await handleOrdering(wa, cw, phone, text, session, customer, tenant, timer);
      break;
    case "PAYMENT":
      await handlePayment(wa, phone, text, session, customer, tenant);
      break;
    case "CONFIRM":
      await handleConfirm(wa, cw, phone, text, t, session, customer, tenant, sessionKey);
      break;
    default:
      // Qualquer step desconhecido cai direto em ORDERING — sem funil de botões
      session.step = "ORDERING";
      session.orderHistory = session.orderHistory || [];
      if (!session.orderHistory.length) {
        session.orderHistory.push({ role: "customer", text });
      }
      await handleOrdering(wa, cw, phone, text, session, customer, tenant, timer);
  }

  if (session._cleared) {
    await clearSession(tenant.id, sessionKey);
  } else {
    await saveSession(tenant.id, sessionKey, session);
  }
}

// ── Status do pedido ──────────────────────────────────────────
function isOrderInProgressSession(session) {
  if (!session || typeof session !== "object") return false;
  const steps = new Set([
    "CHOOSE_PRODUCT_TYPE",
    "FULFILLMENT",
    "ADDRESS",
    "ADDRESS_NUMBER",
    "ADDRESS_CONFIRM",
    "ASK_SIZE",
    "ORDERING",
    "PAYMENT",
    "CONFIRM",
  ]);
  if (steps.has(session.step)) return true;
  if (Array.isArray(session.cart) && session.cart.length > 0) return true;
  if (session.chosenSize || session.fulfillment || session.address || session.productType) return true;
  return false;
}

function buildSessionProgressSummary(session) {
  const parts = [];
  if (session?.productType) parts.push(`tipo: ${session.productType}`);
  if (session?.chosenSize) parts.push(`tamanho: ${session.chosenSize}`);
  if (session?.fulfillment) parts.push(session.fulfillment === "delivery" ? "entrega" : "retirada");
  if (Array.isArray(session?.cart) && session.cart.length) parts.push(`${session.cart.length} item(ns)`);
  return parts.length ? parts.join(" | ") : "montagem em andamento";
}

async function handleStatusQuery(wa, phone, customer, _tenant, session) {
  try {
    const lastOrder = await prisma.order.findFirst({
      where: { customerId: customer.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, createdAt: true },
    });

    if (!lastOrder) {
      if (isOrderInProgressSession(session)) {
        const progress = buildSessionProgressSummary(session);
        const m = `Seu pedido está em andamento por aqui ✅\n\n(${progress})\nMe manda o próximo detalhe e eu continuo de onde paramos.`;
        await wa.sendText(phone, m);
        await chatMemory.push(customer.id, "bot", m);
        return;
      }
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
    const lastOrder = await prisma.order.findFirst({
      where: { customerId: customer.id, status: { notIn: ["delivered", "cancelled"] } },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, cwOrderId: true, createdAt: true },
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

    await orderService.updateStatus(lastOrder.id, "cancelled", "webhook", "Cancelado pelo cliente via WhatsApp");

    const orderNum = lastOrder.id.slice(-6).toUpperCase();
    const m = `❌ Pedido *#${orderNum}* cancelado. Se precisar de algo, é só chamar! 😊`;
    await wa.sendText(phone, m);
    await chatMemory.push(customer.id, "bot", m);
  } catch (err) {
    console.error("[Bot] handleCancelRequest:", err.message);
  }
}

// ── Saudação ──────────────────────────────────────────────────
async function sendGreeting(wa, cw, phone, customer, tenant, session, timer) {
  const storeName = tenant.name || "Pappi Pizza";
  const now = Date.now();
  const lastGreetingAt = Number(session?._lastGreetingAt || 0);
  if (lastGreetingAt > 0 && now - lastGreetingAt < GREETING_COOLDOWN_MS) {
    const waitSec = Math.max(1, Math.ceil((GREETING_COOLDOWN_MS - (now - lastGreetingAt)) / 1000));
    console.log(`[Bot] Saudação suprimida por cooldown (${waitSec}s restantes)`);
    return;
  }

  if (!customer.name) {
    session.step = "ASK_NAME";
    const m = `Oi! 😊 Bem-vindo(a) à ${storeName}! Qual seu nome pra eu te atender?`;
    await wa.sendText(phone, m);
    await chatMemory.push(customer.id, "bot", m);
    return;
  }

  metaCapi.trackContact({ customer }).catch(() => {});

  const isVip = (customer.visitCount || 0) > 0;
  const firstName = customer.name.split(" ")[0];
  const visits = customer.visitCount || 0;

  const urlLine = `\n\n🛒 Se quiser pedir rapidinho, aqui está seu link: ${CW_ORDER_LINK}`;
  const leadLine = session.isLeadOrder
    ? "\n\n⚠️ _Estamos fechados no momento, mas pode me deixar seu pedido por aqui que eu organizo tudo pra você._"
    : "";
  const baseGreeting = isVip ? `Oi ${firstName}, tudo bem? 😊` : `Olá, ${firstName}! Tudo bem? 😊`;

  const FALLBACK_PHRASES = {
    new: "Me fala o que você está com vontade hoje que eu já vou montando seu pedido.",
    vip: "Que bom te ver de volta. Me fala o que vai querer hoje que eu agilizo por aqui.",
  };

  let impactPhrase = FALLBACK_PHRASES[isVip ? "vip" : "new"];
  try {
    timer?.mark("pre_greeting");
    const history = await chatMemory.get(customer.id);
    const aiPhrase = await ai.generateGreetingPhrase({
      storeName,
      firstName,
      visitCount: visits,
      lastOrderSummary: customer.lastOrderSummary || "",
      conversationHistory: history,
      isNew: !isVip,
    });
    if (aiPhrase && aiPhrase.length > 5) impactPhrase = aiPhrase;
    timer?.mark("generateGreetingPhrase");
  } catch (err) {
    console.warn("[Bot] generateGreetingPhrase falhou, usando fallback:", err.message);
    timer?.mark("greeting_fallback");
  }

  const greeting = `${baseGreeting}
${impactPhrase}${urlLine}${leadLine}`;
  await wa.sendText(phone, greeting);
  await chatMemory.push(customer.id, "bot", greeting);
  session._lastGreetingAt = Date.now();
  session.step = "MENU";
}

// Pergunta Pizza ou Lasanha
async function sendProductTypePrompt(wa, phone, customer, session) {
  const now = Date.now();
  const lastMenuAt = Number(session?._lastMenuPromptAt || 0);
  if (lastMenuAt > 0 && now - lastMenuAt < MENU_COOLDOWN_MS) {
    return;
  }
  session.step = "CHOOSE_PRODUCT_TYPE";
  const m = "Me fala o que você quer hoje — pizza, lasanha, bebida ou até seu pedido completo 😊";
  await wa.sendText(phone, m);
  await chatMemory.push(customer.id, "bot", m);
  session._lastMenuPromptAt = Date.now();
}

// Pergunta Entrega ou Retirada
async function sendFulfillmentPromptOnly(wa, phone, customer, tenant, session) {
  session.step = "FULFILLMENT";
  const m = "Perfeito. Vai ser entrega ou retirada?";
  await wa.sendText(phone, m);
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

  function optionLooksLikeSizeOption(name) {
    const n = normalizeText(String(name || ""));
    // Tamanhos Pappi: Broto/Grande/Gigante ou números/pedaços (4/8/16 pedaços etc).
    return (
      /\b(broto|media|grande|gigante|gigant)\b/i.test(n) ||
      /\b\d{1,3}\b/.test(n) ||
      /\b\d{1,3}\s*p\b/i.test(n) ||
      /peda(c|ç)os/.test(n) ||
      /fatias/.test(n)
    );
  }

  for (const cat of useCats) {
    for (const item of cat.items || cat.products || []) {
      if (item.status === "INACTIVE") continue;
      for (const g of item.option_groups || []) {
        if (g.status === "INACTIVE" || !g.options) continue;
        const gn = (g.name || "").toLowerCase();

        // Regra mais segura: inferir tamanho pelo formato das opções (dígitos/pedaços/broto),
        // evitando confundir grupos de "sabor" com grupos de "tamanho".
        const groupHasSizeOption = g.options.some((o) => optionLooksLikeSizeOption(o?.name));
        const groupLooksPlausible = /tamanho|size|fatias|peda/.test(gn) || groupHasSizeOption;

        if (!groupLooksPlausible) continue;

        for (const o of g.options) {
          if (o.status === "INACTIVE" || !o.name) continue;
          if (optionLooksLikeSizeOption(o.name)) sizes.add(o.name.trim());
        }
      }
    }
  }
  const sizeList = [...sizes].length ? [...sizes] : ["Broto", "Grande", "Gigante"];
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
async function handleAskName(wa, cw, phone, text, session, customer, tenant, timer) {
  const name = text.trim();
  if (!name || name.length < 2) {
    await wa.sendText(phone, "Pode me dizer seu nome? 😊");
    return;
  }
  const updated = await customerService.setName(customer.id, name);
  customer.name = updated.name;
  customer.visitCount = updated.visitCount;

  session.step = "MENU";
  await sendGreeting(wa, cw, phone, updated, tenant, session, timer);
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
      await enrichAddressObjectForDelivery(session.address, tenant, cw);
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
async function handleAddress(wa, cw, phone, text, session, customer, tenant, timer) {
  const t = (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const isFulfillmentClick =
    t.includes("entrega") || t.includes("retirada") || t.includes("retirar") || t === "delivery" || t === "takeout";
  const isShortMessage = (text || "").trim().length <= 15; // Cliques de botão são curtos
  if (isFulfillmentClick && isShortMessage) {
    session.addressBuffer = [];
    session.addressFailCount = 0;
    const m = "Perfeito. Me manda o endereço do jeito que ficar mais fácil pra você: CEP, rua com número e bairro, ou localização 📍";
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
    const resolved = await resolveAddressFromFreeText(input, tenant, cw);
    return resolved;
  }

  timer?.mark("pre_extractAddress");
  const resolved = await tryParseAddress(combined);
  const addr = resolved?.addr || null;
  timer?.mark("extractAddress");

  if (!addr?.street) {
    session.addressFailCount += 1;
    const minLenToReply = 8;
    if (combined.length < minLenToReply && session.addressBuffer.length < 2) {
      // Fragmento curto — não repetir "não entendi", só pedir o resto
      const m = "Pode me mandar o restante do endereço? Ex.: Rua X, 123, Bairro — ou só o CEP.";
      await wa.sendText(phone, m);
      await chatMemory.push(customer.id, "bot", m);
      return;
    }
    const isRepeat = session.addressFailCount >= 2;
    const m = isRepeat
      ? "Pra eu acertar de primeira, me manda o *CEP* ou a *localização*. Se preferir, pode mandar Rua, Número e Bairro."
      : "Ainda não consegui montar esse endereço certinho. Me manda *CEP* ou *Rua, Número e Bairro*, por favor.";
    await wa.sendText(phone, m);
    await chatMemory.push(customer.id, "bot", m);
    return;
  }

  session.addressBuffer = [];
  session.addressFailCount = 0;

  if (!addr.number) {
    session.partialAddress = addr;
    session.step = "ADDRESS_NUMBER";
    const m = `Encontrei: *${addr.formatted || addr.street}*\nQual o número da casa?`;
    await wa.sendText(phone, m);
    await chatMemory.push(customer.id, "bot", m);
    return;
  }

  if (resolved?.confidence === "medium") {
    addr.formatted = addr.formatted || `${addr.street}, ${addr.number}${addr.neighborhood ? ` - ${addr.neighborhood}` : ""}`;
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
  let coverageOk = false;
  let explicitOutOfRange = false;
  let geo = null;
  try {
    geo = await Maps.quote(fullAddress, cw);
    if (geo) {
      addr.formatted = geo.formatted_address || fullAddress;
      addr.lat = geo.lat;
      addr.lng = geo.lng;
      explicitOutOfRange = indicatesOutOfRange(geo);
      if (!explicitOutOfRange) {
        const fee = extractDeliveryFeeFromResult(geo);
        if (Number.isFinite(fee) && fee >= 0) {
          session.deliveryFee = fee;
          const kmStr = geo.km != null ? ` | ${geo.km} km` : "";
          feeText = `\nTaxa: R$ ${fee.toFixed(2)}${kmStr}`;
          coverageOk = true;
        } else if (hasSoftDeliveryCoverage(geo)) {
          feeText = "\nTaxa: vou te confirmar certinho no fechamento do pedido.";
          coverageOk = true;
        }
      }
    } else {
      addr.formatted = fullAddress;
    }
  } catch {
    addr.formatted = fullAddress;
  }

  if (!coverageOk && !explicitOutOfRange) {
    try {
      const feeResult =
        Number.isFinite(addr?.lat) && Number.isFinite(addr?.lng)
          ? await cw.getDeliveryFee({ lat: addr.lat, lng: addr.lng })
          : await cw.getDeliveryFee({});
      explicitOutOfRange = indicatesOutOfRange(feeResult);
      if (!explicitOutOfRange) {
        const fee = extractDeliveryFeeFromResult(feeResult);
        if (Number.isFinite(fee) && fee >= 0) {
          session.deliveryFee = fee;
          feeText = `\nTaxa: R$ ${fee.toFixed(2)}`;
          coverageOk = true;
        } else if (hasSoftDeliveryCoverage(geo || addr)) {
          feeText = "\nTaxa: vou te confirmar certinho no fechamento do pedido.";
          coverageOk = true;
        }
      }
    } catch {}
  }

  if (!coverageOk && explicitOutOfRange) {
    await sendOutOfRangePrompt(wa, phone, customer, session);
    return;
  }

  if (!coverageOk) {
    await sendAddressReviewPrompt(wa, phone, customer, session);
    return;
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
  if (t.includes("corrig") || t.includes("errado") || t.includes("outro") || text === "change_addr") {
    session.step = "ADDRESS";
    delete session.address;
    session.addressBuffer = [];
    session.addressFailCount = 0;
    await wa.sendText(phone, "Sem problema. Me manda o endereço correto do jeito que ficar melhor pra você:");
    return;
  }
  // confirm_addr, "confirma", "sim", "ok" — segue para startOrdering abaixo

  // CORREÇÃO: persiste o endereço confirmado no banco para reutilizar na próxima vez
  if (session.address) {
    await customerService.touchInteraction(customer.id, session.address).catch(() => {});
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

async function handleDeliveryCoverageDecision(wa, cw, phone, text, t, session, customer, tenant) {
  const lower = String(text || "").toLowerCase();
  const chooseAddress = text === "oor_change_addr" || lower.includes("outro endereco") || lower.includes("outro endereço");
  const chooseTakeout =
    text === "oor_takeout" ||
    t.includes("retirada") ||
    t.includes("retirar") ||
    t.includes("buscar") ||
    lower === "takeout";

  if (chooseTakeout) {
    session.fulfillment = "takeout";
    delete session.address;
    delete session.deliveryFee;
    await startOrdering(wa, cw, phone, session, customer, tenant);
    return;
  }

  if (chooseAddress) {
    session.step = "ADDRESS";
    delete session.address;
    delete session.deliveryFee;
    session.addressBuffer = [];
    session.addressFailCount = 0;
    const m = "Tudo bem. Me manda outro endereço, o CEP ou a localização 📍";
    await wa.sendText(phone, m);
    await chatMemory.push(customer.id, "bot", m);
    return;
  }

  await sendOutOfRangePrompt(wa, phone, customer, session);
}

// ── startOrdering ─────────────────────────────────────────────
async function startOrdering(wa, cw, phone, session, customer, _tenant) {
  const [rawCatalog] = await Promise.all([cw.getCatalog(), cw.getPaymentMethods()]);
  const fullCatalog = rawCatalog?.catalog || rawCatalog?.data || rawCatalog;
  session.catalog = fullCatalog;

  const prefix = session.fulfillment === "takeout" ? "🏪 Fechado, retirada então. " : session.fulfillment === "delivery" ? "🛵 Perfeito, entrega então. " : "";

  session.step = "ORDERING";
  session.orderHistory = session.orderHistory || [];
  if (session.initialIntakeText && session.orderHistory.length === 0) {
    session.orderHistory.push({ role: "customer", text: session.initialIntakeText });
  }

  const m = `${prefix}Pode me mandar seu pedido do jeito que você falaria pra um atendente 😊
Ex.: pizza grande meia calabresa meia portuguesa, coca 2L, pagamento no pix.

Se preferir pedido rapidinho: ${CW_ORDER_LINK}`;
  await wa.sendText(phone, m);
  await chatMemory.push(customer.id, "bot", m);
}

// ── ASK_SIZE ──────────────────────────────────────────────────
async function handleAskSize(wa, cw, phone, text, session, customer, tenant) {
  const sizes = session.sizeOptions || [];
  const sizeResolution = resolveCatalogSizeFromText(text, sizes);
  const chosen = sizeResolution.chosen;

  if (!chosen && sizes.length) {
    const m = `Qual tamanho você prefere? ${sizes.slice(0, 4).join(", ")}`;
    await wa.sendText(phone, m);
    return;
  }

  session.chosenSize = chosen || sizes[0];
  session.step = "ORDERING";
  session.orderHistory = session.orderHistory || [];
  if (session.initialIntakeText && session.orderHistory.length === 0) {
    session.orderHistory.push({ role: "customer", text: session.initialIntakeText });
  }

  if (sizeResolution.remainder && sizeResolution.remainder.length >= 4) {
    await handleOrdering(wa, cw, phone, sizeResolution.remainder, session, customer, tenant);
    return;
  }

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
async function handleOrdering(wa, cw, phone, text, session, customer, tenant, timer) {
  const sessionKey = sessionService.discriminatorFromCustomer(customer);
  session.orderHistory.push({ role: "customer", text });

  const rawIn = String(text || "").trim();
  if (rawIn.length >= 72) {
    const ack = "Recebi tudo — já tô montando seu pedido e buscando os valores no cardápio ⚡";
    await wa.sendText(phone, ack);
    await chatMemory.push(customer.id, "bot", ack);
  }

  const catalog =
    session.filteredCatalog &&
    (session.filteredCatalog?.categories?.length || session.filteredCatalog?.sections?.length)
      ? session.filteredCatalog
      : session.catalog;
  const sizeHint = session.chosenSize ? `Tamanho já escolhido: ${session.chosenSize}. ` : "";

  timer?.mark("pre_chatOrder");
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
    tenantId: tenant.id,
    phone: learningKeyFromCustomer(customer),
  });
  timer?.mark("chatOrder");

  session.orderHistory.push({ role: "bot", text: result.reply });
  if (session.prefersAudio && !result.reply.includes("👇") && !result.reply.includes("💳")) {
    let sentAudio = false;
    if (wa.sendPresence) await wa.sendPresence(phone, "recording");
    const audioBuf = await audioSynthesis.synthesizeTextToAudio(result.reply);
    if (audioBuf && typeof wa.sendAudio === "function") {
      await wa.sendAudio(phone, audioBuf, null, true);
      sentAudio = true;
    }
    if (!sentAudio) {
      if (wa.sendPresence) await wa.sendPresence(phone, "composing");
      await wa.sendText(phone, result.reply);
    }
  } else {
    if (wa.sendPresence) await wa.sendPresence(phone, "composing");
    await wa.sendText(phone, result.reply);
  }
  await chatMemory.push(customer.id, "bot", result.reply);

  if (result.done && result.items?.length > 0) {
    if (result.notes) session.notes = result.notes;

    // ── Delega precificação ao CW via prefilled_order ─────────
    // O CW é a Fonte da Verdade para totais; o cálculo local é apenas fallback de emergência.
    const log = logger.child({ service: "bot.ordering" });
    try {
      const prefilled = await cw.createPrefilledOrder({
        items: result.items,
        fulfillment: session.fulfillment || null,
        address: session.address || null,
        customerPhone: customer.phone,
      });

      // Se o CW devolveu items detalhados com unit_price, atualiza o carrinho com eles.
      // Caso contrário, mantém os itens da IA (preço local 0) — o total oficial está em cwPrefilledTotal.
      if (Array.isArray(prefilled?.items) && prefilled.items.length > 0) {
        session.cart = prefilled.items.map((cwItem, i) => {
          const aiItem = result.items[i] || result.items[0] || {};
          return {
            ...aiItem,
            id: cwItem.product_id || cwItem.id || aiItem.id,
            name: cwItem.name || aiItem.name,
            quantity: Math.max(1, parseInt(aiItem.quantity, 10) || 1),
            unit_price: round2(parseFloat(cwItem.unit_price ?? cwItem.price ?? 0)),
            _pricedFromCW: true,
          };
        });
      } else {
        // CW confirmou o pedido mas não detalhou items — mantém os itens da IA
        session.cart = result.items.map((i) => ({ ...i, _pricedFromCW: false }));
      }

      // Total e taxa oficiais do CW
      if (Number.isFinite(prefilled?.order_amount) && prefilled.order_amount > 0) {
        session.cwPrefilledTotal = round2(prefilled.order_amount);
      }
      if (Number.isFinite(prefilled?.delivery_fee)) {
        session.deliveryFee = round2(prefilled.delivery_fee);
      }
      if (prefilled?.link) session.cwPrefilledLink = prefilled.link;

      log.info({ tenantId: tenant.id, total: session.cwPrefilledTotal }, "createPrefilledOrder OK");
    } catch (prefilledErr) {
      // Fallback: tenta pricing local via catálogo
      log.warn(
        { tenantId: tenant.id, err: prefilledErr.message },
        "createPrefilledOrder falhou — fallback para catálogo local",
      );
      const priced = cartPricing.enrichCartFromCatalog(result.items, catalog, {
        chosenSize: session.chosenSize,
        productType: session.productType,
      });
      session.cart = priced.items;

      if (priced.hasUnpriced) {
        // Ambos falharam — envia link direto e aguarda nova tentativa
        const warn =
          `⚠️ Estou com dificuldade de fechar o preço agora. ` +
          `Faça o pedido diretamente pelo link (é rápido!) 👇\n${CW_ORDER_LINK}`;
        await wa.sendText(phone, warn);
        await chatMemory.push(customer.id, "bot", warn);
        session.step = "ORDERING";
        await saveSession(tenant.id, sessionKey, session);
        return;
      }
    }

    // ── Coleta fulfillment se ainda não temos ─────────────────
    if (!session.fulfillment) {
      session.step = "FULFILLMENT";
      const msg = "Perfeito. Vai ser entrega ou retirada?";
      await wa.sendButtons(phone, msg, [
        { id: "delivery", title: "🚚 Entrega" },
        { id: "takeout",  title: "🏪 Retirada" },
      ]);
      await chatMemory.push(customer.id, "bot", msg);
      return;
    }

    // ── Coleta endereço se delivery e ainda não temos ─────────
    if (session.fulfillment === "delivery" && !session.address) {
      session.step = "ADDRESS";
      const msg = "🛵 Quase lá! Me manda o endereço do jeito que preferir: completo, CEP ou localização 📍";
      await wa.sendText(phone, msg);
      await chatMemory.push(customer.id, "bot", msg);
      return;
    }

    // Pagamento já veio no texto inicial ("quero pizza, pago no pix")
    if (session.paymentMethodName) {
      await handlePayment(wa, phone, session.paymentMethodName, session, customer, tenant);
      return;
    }

    // ── Exibe resumo com total oficial do CW e pede pagamento ─
    session.step = "PAYMENT";
    const totalParaExibir = session.cwPrefilledTotal
      ? session.cwPrefilledTotal
      : calculate({ items: session.cart, deliveryFee: session.deliveryFee || 0, discount: 0 }).expectedTotal;

    const entregaLinha =
      session.fulfillment === "delivery"
        ? `\n🛵 Taxa entrega: *R$ ${(session.deliveryFee || 0).toFixed(2)}*`
        : "";

    const payMsg =
      `💰 *Resumo do pedido*\n${cartSummary(session.cart, { omitTotal: true })}${entregaLinha}\n\n` +
      `✅ *Total: R$ ${totalParaExibir.toFixed(2)}*\n\n` +
      `E o pagamento vai ser como? 💳\n\n${listPayments(tenant.id)}`;
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

  // Usa cwPrefilledTotal como Fonte da Verdade; calculate() apenas para estrutura do breakdown
  let calc = calculate({ items: session.cart, deliveryFee: session.deliveryFee || 0 });
  if (session.cwPrefilledTotal && session.cwPrefilledTotal > 0) {
    calc = { ...calc, expectedTotal: round2(session.cwPrefilledTotal) };
  }
  session.calc = calc;

  // ── CAPI: InitiateCheckout ────────────────────────────────
  metaCapi
    .trackInitiateCheckout({ customer, cart: session.cart, deliveryFee: session.deliveryFee || 0 })
    .catch(() => {});

  const addrLine =
    session.fulfillment === "delivery" && session.address ? `📍 *Endereço:* ${session.address.formatted}\n` : "";
  const feeLine = session.deliveryFee ? `🛵 *Taxa:* R$ ${session.deliveryFee.toFixed(2)}\n` : "";
  const totalLine = `💰 *Total: R$ ${calc.expectedTotal.toFixed(2)}*\n`;

  const m = `📋 *Resumo do pedido:*\n\n${cartSummary(session.cart, { omitTotal: true })}\n${feeLine}${addrLine}${totalLine}\n💳 *Pagamento:* ${mapped.name}\n\nConfirmar?`;
  await wa.sendButtons(phone, m, [
    { id: "CONFIRMAR", title: "✅ Confirmar" },
    { id: "CANCELAR", title: "❌ Cancelar" },
  ]);
  await chatMemory.push(customer.id, "bot", m);
}

// ── CONFIRM ───────────────────────────────────────────────────
async function handleConfirm(wa, cw, phone, text, t, session, customer, tenant, sessionKey) {
  if (t.includes("cancel") || text === "CANCELAR") {
    session._cleared = true;
    await wa.sendText(phone, "Pedido cancelado. Quando quiser, é só chamar! 😊");
    return;
  }

  // Preços já foram validados pelo CW via createPrefilledOrder em handleOrdering.
  // cwPrefilledTotal é a Fonte da Verdade; calculate() fornece apenas o breakdown por item.
  let calc = calculate({ items: session.cart, deliveryFee: session.deliveryFee || 0, discount: session.discount || 0 });
  if (session.cwPrefilledTotal && session.cwPrefilledTotal > 0) {
    calc = { ...calc, expectedTotal: round2(session.cwPrefilledTotal) };
  }
  const isLead = !!session.isLeadOrder;

  await wa.sendText(phone, "⏳ Processando seu pedido...");

  let cwResponse = null,
    cwOrderId = null,
    cwSuccess = false;
  let cwPayload = null;

  // Delivery: valida pré-requisitos operacionais (não envia CW sem endereço completo + coords + CEP)
  if (session.fulfillment === "delivery") {
    if (session.address) {
      await enrichAddressObjectForDelivery(session.address, tenant, cw);
    }
    const a = session.address || null;
    const cep = (a?.zipCode || "").replace(/\D/g, "") || (a?.formatted ? extractCepDigitsFromString(a.formatted) : "");
    const hasCoords =
      Number.isFinite(a?.lat) &&
      Number.isFinite(a?.lng) &&
      Math.abs(a.lat) > 1e-5 &&
      Math.abs(a.lng) > 1e-5;
    const ok =
      cep.length === 8 &&
      hasCoords &&
      (a?.street || "").trim() &&
      (a?.number || "").trim() &&
      (a?.neighborhood || "").trim() &&
      (a?.city || "").trim() &&
      (a?.state || "").trim();

    if (!ok) {
      session.step = "ADDRESS";
      await wa.sendText(
        phone,
        "⚠️ Pra entrega eu preciso do endereço completo (CEP + rua + número + bairro) e sua localização/coords pra calcular a taxa. Pode me mandar o endereço certinho? 📍",
      );
      await saveSession(tenant.id, sessionKey, session);
      return;
    }

    // Recalcular delivery_fee baseado em coords (fonte mestre: CW) e bloquear fora de área.
    try {
      const feeResult = await cw.getDeliveryFee({ lat: a.lat, lng: a.lng });
      if (indicatesOutOfRange(feeResult)) {
        await sendOutOfRangePrompt(wa, phone, customer, session);
        await saveSession(tenant.id, sessionKey, session);
        return;
      }
      const fee = extractDeliveryFeeFromResult(feeResult);
      if (Number.isFinite(fee) && fee >= 0) {
        session.deliveryFee = fee;
        calc = calculate({ items: session.cart, deliveryFee: fee, discount: session.discount || 0 });
      }
    } catch {
      // Se a taxa não vier agora, seguimos e deixamos o CW validar no fechamento.
    }
  }

  // Monta payload final CW — order_amount calculado dos itens reais (não sobrescrever)
  if (!isLead) {
    cwPayload = buildCwPayload({ session, customer, calc });
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
  // PIX: cria cobrança, salva pedido pendente, NÃO envia ao CW aqui
  const isPix = /pix/i.test(String(session.paymentMethodName || "")) || /pix/i.test(String(session.paymentMethodId || ""));
  let pixTxid = null;
  let pixCopiaECola = null;

  if (!isLead && isPix && !orderPixDbCompat.hasOrderPixColumns()) {
    await wa.sendText(
      phone,
      "⚠️ O pagamento por *PIX* ainda não está ativo neste ambiente (banco sem as colunas necessárias). Use outra forma de pagamento ou fale com um atendente — a equipe já foi alertada.",
    );
    await baileys
      .notify(
        "⚠️ *PIX bloqueado*: aplique no PostgreSQL as colunas `pixTxid`, `pixE2eId`, `pixStatus` em `public.orders` (migration PIX) e faça deploy.",
      )
      .catch(() => {});
    return;
  }

  if (!isLead && isPix) {
    pixTxid = randomUUID().replace(/-/g, "").slice(0, 32);
    try {
      const r = await interPix.createCob({
        txid: pixTxid,
        amount: calc.expectedTotal,
        payerName: customer.name || "Cliente",
        message: `Pedido Pappi (${customer.phone || ""})`,
      });
      pixCopiaECola = r?.copiaECola || null;
      // guarda raw no cwResponse (campo já existente) para debug — sem mudar contrato CW
      cwResponse = { pix: { txid: pixTxid, copiaECola: pixCopiaECola, raw: r?.raw || null } };
    } catch (err) {
      console.error(`[${tenant.id}] Erro ao gerar PIX Inter:`, err.message);
      // Fallback: mantém pedido pendente mesmo sem copia/cola (operador pode cobrar manualmente)
      cwResponse = { pix: { txid: pixTxid, error: err.message } };
    }
  }

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
    cwOrderId: isLead || isPix ? null : cwOrderId,
    cwPayload: isLead ? null : cwPayload,
    cwResponse: isLead ? null : cwResponse,
    status: isLead ? "lead" : isPix ? "pix_pending" : undefined,
  });

  if (pixTxid && orderPixDbCompat.hasOrderPixColumns()) {
    await prisma.order.update({
      where: { id: order.id },
      data: { pixTxid, pixStatus: "pending" },
      select: { id: true },
    });
  } else if (pixTxid) {
    const log = logger.child({ service: "bot" });
    log.error(
      { orderId: order.id },
      "PIX: pedido criado mas banco sem colunas pixTxid/pixE2eId/pixStatus — migration PIX pendente; txid não persistido.",
    );
    baileys
      .notify(
        `⚠️ *PIX*: pedido #${order.id.slice(-6).toUpperCase()} sem persistir txid — rode migration em \`orders\` (pixTxid, pixE2eId, pixStatus).`,
      )
      .catch(() => {});
  }

  // Cartão/dinheiro: envia direto ao CW (como antes). PIX: só envia após webhook.
  if (!isLead && !isPix) {
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
  }

  if (cwOrderId) await setCwOrderId(order.id, cwOrderId, cwResponse);
  await recordOrder(customer.id, cartSummary(session.cart), session.paymentMethodName);

  // ── Aprendizado: captura preferências do cliente ────────
  try {
    const lk = learningKeyFromCustomer(customer);
    await botLearning.learnCustomerPattern(tenant.id, lk, {
      favoriteItems: session.cart.map((i) => ({ name: i.name })),
      paymentMethod: session.paymentMethodName,
      fulfillment: session.fulfillment,
      orderHour: new Date().getHours(),
    });
    await botLearning.analyzeConversation(tenant.id, customer.id, lk);
  } catch {}

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

  const cartOpts = { notes: session.notes || "" };
  let m;
  if (isLead) {
    m = `✅ *Pedido #${orderNum} anotado!*\n\n${cartSummary(session.cart, cartOpts)}\n💳 ${session.paymentMethodName}${addrLine}\n\nEntraremos em contato quando abrirmos. Obrigado! 🍕`;
  } else if (isPix) {
    m =
      `💸 *PIX gerado — Pedido #${orderNum}*\n\n` +
      `${cartSummary(session.cart, cartOpts)}\n` +
      `Total: R$ ${calc.expectedTotal.toFixed(2)}\n\n` +
      (pixCopiaECola
        ? `📌 *Copia e cola:*\n${pixCopiaECola}\n\nAssim que confirmar o pagamento, seu pedido será enviado e você recebe a confirmação aqui. ✅`
        : (() => {
            const fallbackKey =
              ENV.PIX_FALLBACK_KEY ||
              "CHAVE PIX (PREENCHER) — CNPJ XX.XXX.XXX/0001-XX ou Telefone (PREENCHER)";
            return (
              "⚠️ Ocorreu um atraso ao gerar o código *copia e cola*.\n\n" +
              `Você pode transferir o valor para a nossa *chave PIX*: ${fallbackKey}\n` +
              "e enviar o comprovante aqui para conferência. ✅"
            );
          })());
  } else if (cwSuccess) {
    const previsao = session.fulfillment === "takeout" ? "30 a 40 min" : "60 min";
    m = `✅ *Pedido #${orderNum} confirmado!*\n\n${cartSummary(session.cart, cartOpts)}\n💳 ${session.paymentMethodName}${addrLine}\n⏱️ Previsão: ${previsao}\n\nObrigado! 🍕`;
  } else {
    m = `✅ *Pedido recebido!*\n\nEstamos processando e entraremos em contato em breve. Obrigado! 🍕`;
  }

  const receipt = buildOrderReceiptMessage({
    order,
    customer,
    session,
    calc,
    cwOrderId,
  });
  const finalMsg = `${m}\n\n${receipt}`;
  await wa.sendText(phone, finalMsg);
  // Envia áudio da confirmação se o cliente prefere áudio
  if (session.prefersAudio && wa.sendPresence && typeof wa.sendAudio === "function") {
    try {
      await wa.sendPresence(phone, "recording");
      const audioBuf = await audioSynthesis.synthesizeTextToAudio(m);
      if (audioBuf) await wa.sendAudio(phone, audioBuf, null, true);
    } catch {}
  }
  await chatMemory.push(customer.id, "bot", finalMsg);
}

// ── Helpers ───────────────────────────────────────────────────
function cartSummary(cart, opts = {}) {
  if (!cart?.length) return "Carrinho vazio";
  const lines = cart.map((i) => {
    const sub = (Number(i.unit_price) || 0) * (Number(i.quantity) || 1);
    const money = sub > 0 ? `R$ ${sub.toFixed(2)}` : "preço a confirmar";
    return `• ${i.quantity}x ${i.name} — ${money}`;
  });
  const total = cart.reduce((s, i) => s + (Number(i.unit_price) || 0) * (Number(i.quantity) || 1), 0);
  const totalLine = total > 0 ? `R$ ${total.toFixed(2)}` : "total a confirmar no cardápio";
  const body = lines.join("\n");
  const notesLine = opts.notes ? `\n📝 Obs: ${opts.notes}` : "";
  if (opts.omitTotal) return body + notesLine;
  return body + notesLine + `\n\n*Subtotal itens: ${totalLine}*`;
}

function formatMoney(v) {
  return `R$ ${Number(v || 0).toFixed(2)}`;
}

function buildOrderReceiptMessage({ order, customer, session, calc, cwOrderId }) {
  const now = new Date();
  const madeAt = now.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const orderNo = order?.id ? order.id.slice(-6).toUpperCase() : "----";
  const integrationLine = cwOrderId ? `\n🔗 CW #${cwOrderId}` : "";
  const phoneFmt = String(customer?.phone || "")
    .replace(/^55(\d{2})(\d{4,5})(\d{4})$/, "($1) $2-$3")
    .trim();
  const fulfillLine =
    session?.fulfillment === "delivery"
      ? `📍 Entrega: ${session?.address?.formatted || "Endereço informado"}`
      : "📍 Retirar na loja";
  const items = Array.isArray(session?.cart) ? session.cart : [];
  const itemsText =
    items
      .map((i) => {
        const qty = Number(i?.quantity || 1);
        const unit = Number(i?.unit_price || 0);
        const lineTotal = unit * qty;
        return `${qty} x ${i?.name || "Item"}\n💵 ${qty} x ${formatMoney(unit)} = ${formatMoney(lineTotal)}`;
      })
      .join("\n\n") || "Sem itens";
  const subtotal = Number(calc?.subtotal || 0);
  const finalTotal = Number(calc?.expectedTotal || subtotal);
  const payName = session?.paymentMethodName || "Não informado";
  const obsLine = session?.notes ? `📝 Obs: ${session.notes}\n\n` : "";
  return (
    `#️⃣ Pedido Nº ${orderNo} (Integração)\n` +
    `feito em ${madeAt}${integrationLine}\n\n` +
    `👤 ${customer?.name || "Cliente"}\n` +
    `📞 ${phoneFmt || customer?.phone || "—"}\n\n` +
    `${fulfillLine}\n\n` +
    `------ ITENS DO PEDIDO ------\n\n` +
    `${itemsText}\n\n` +
    `-----------------------------\n\n` +
    obsLine +
    `SUBTOTAL: ${formatMoney(subtotal)}\n\n` +
    `VALOR FINAL: ${formatMoney(finalTotal)}\n\n` +
    `💲 FORMA DE PAGAMENTO\n\n` +
    `${payName}: ${formatMoney(finalTotal)}`
  );
}

function buildCwPayload({ session, customer, calc }) {
  const rawPhone = customer.phone != null ? String(customer.phone) : "";
  const localPhone = rawPhone.startsWith("55") ? rawPhone.slice(2) : rawPhone;
  // API exige exatamente 11 dígitos
  const phone11 = localPhone.replace(/\D/g, "").slice(-11).padStart(11, "0").slice(0, 11);
  const cwOrderId = randomUUID();
  const displayId = cwOrderId.slice(-6).toUpperCase();
  const isDelivery = session.fulfillment === "delivery";
  const deliveryFee = isDelivery ? round2(calc.deliveryFee || 0) : 0; // deve ser 0 para takeout
  const discounts = round2(calc.discount || 0);

  // Monta itens com total_price correto conforme spec:
  // total_price = (unit_price + sum(options.qty × options.unit_price)) × quantity
  const items = session.cart.map((i) => {
    const qty = Math.max(1, parseInt(i.quantity, 10) || 1);
    const unitPrice = round2(Number(i.unit_price) || 0);
    const addons = (i.addons || []).filter(a => a.name); // remove entradas sem nome
    const optionsSum = round2(addons.reduce((s, a) => s + round2((a.unit_price || 0) * Math.max(1, a.quantity || 1)), 0));
    const totalPrice = round2((unitPrice + optionsSum) * qty);

    const item = {
      ...(i.id ? { item_id: String(i.id) } : {}),
      name: String(i.name),
      quantity: qty,
      unit_price: unitPrice,
      total_price: totalPrice,
    };

    // Opções: só envia se houver addons com preço > 0 (CW ignora opções de preço zero sem option_id)
    const cwOptions = addons
      .filter(a => (a.unit_price || 0) > 0 || a.id)
      .map(a => ({
        name: String(a.name),
        quantity: Math.max(1, a.quantity || 1),
        unit_price: round2(a.unit_price || 0),
        ...(a.id ? { option_id: String(a.id) } : {}),
      }));
    if (cwOptions.length) item.options = cwOptions;

    return item;
  });

  // order_amount DEVE ser exatamente sum(items.total_price) + delivery_fee + 0 - discounts
  // Calcula a partir dos itens do payload (não de calc.expectedTotal) para evitar divergência
  const itemsSum = round2(items.reduce((s, i) => s + i.total_price, 0));
  const orderAmount = round2(itemsSum + deliveryFee - discounts);

  const payload = {
    order_id: cwOrderId,
    display_id: displayId,
    order_type: isDelivery ? "delivery" : "takeout",
    created_at: new Date().toISOString(),
    customer: { phone: phone11, name: customer.name || "Cliente WhatsApp" },
    ...(session.notes ? { observation: session.notes } : {}),
    totals: {
      order_amount: orderAmount,
      delivery_fee: deliveryFee,
      additional_fee: 0,
      discounts,
    },
    items,
    payments: [
      {
        total: orderAmount,
        payment_method_id: parseInt(session.paymentMethodId, 10) || session.paymentMethodId,
      },
    ],
  };

  if (isDelivery && session.address) {
    payload.delivery_address = {
      state: session.address.state || "SP",
      city: session.address.city || "",
      neighborhood: session.address.neighborhood || "",
      street: session.address.street || "",
      number: String(session.address.number || ""),
      postal_code: (session.address.zipCode || "").replace(/\D/g, "").slice(0, 8),
      coordinates: {
        latitude: Number(session.address.lat) || 0,
        longitude: Number(session.address.lng) || 0,
      },
      ...(session.address.complement ? { complement: session.address.complement } : {}),
      ...(session.address.reference ? { reference: session.address.reference } : {}),
    };
  }

  return payload;
}

// ── Salva mensagem enviada pelo Baileys ───────────────────────
// waMessageId opcional: usado para check azul e deduplicação em recovery (append)
// opts.customerId: quando o cliente não tem `phone` (ex.: só @lid), obrigatório para não perder a mensagem
// opts.mediaType: text | image | audio | … (painel / histórico)
async function saveBaileysMessage(phone, text, tenantId, role = "assistant", waMessageId = null, opts = {}) {
  try {
    const log = logger.child({ service: "bot.baileys-msg" });
    const { customerId, mediaType, mediaUrl, originalTimestamp } = opts || {};

    let customer = null;
    if (customerId) {
      customer = await prisma.customer.findUnique({ where: { id: customerId } });
    }
    if (!customer && phone) {
      const normalizedPhone = PhoneNormalizer.normalize(phone) || phone;
      customer = await prisma.customer.findUnique({
        where: { tenantId_phone: { tenantId, phone: normalizedPhone } },
      });
    }
    if (customer) {
      const sender = role === "customer" ? null : role === "human" ? "WhatsApp App" : "WhatsApp Auxiliar";
      await chatMemory.push(
        customer.id,
        role,
        text,
        sender,
        mediaUrl || null,
        mediaType || "text",
        waMessageId,
        null,
        originalTimestamp || null,
      );
      log.info(
        { pipeline: "message_saved", customerId: customer.id, role, mediaType: mediaType || "text", waMessageId },
        "message_saved",
      );
    } else {
      log.warn(
        { pipeline: "save_failed", tenantId, phone, customerId, waMessageId },
        "Cliente não encontrado para salvar mensagem Baileys",
      );
    }
  } catch (err) {
    const log = logger.child({ service: "bot.baileys-msg" });
    log.error({ pipeline: "save_failed", err }, "[Bot] Erro ao salvar msg Baileys");
  }
}

module.exports = { handle, saveBaileysMessage };
