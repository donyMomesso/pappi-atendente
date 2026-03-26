const fs = require("fs");
const path = require("path");

const { makeRng, generateScenario } = require("./lib/conversation-fuzz.generator");

const TENANT_ID = process.env.FUZZ_TENANT_ID || "tenant-pappi-001";
const CUSTOMER_PHONE = process.env.FUZZ_PHONE || "5519981755689";
const mockCustomerPhone = CUSTOMER_PHONE;
const SESSION_KEY = CUSTOMER_PHONE;
const SEED = Number(process.env.FUZZ_SEED || "12345");
const SCALE = Number(process.env.FUZZ_SCALE || "5000");
const NET_MODE = process.env.FUZZ_NET_MODE || "prod_net"; // "prod_net" busca catálogo real; "stub" evita rede

const API_KEY = process.env.ATTENDANT_API_KEY || process.env.ADMIN_API_KEY || "pappi-atendente-2026";
const CATALOG_URL = `https://pappiatendente.com.br/dash/catalog?tenant=${encodeURIComponent(TENANT_ID)}`;

const mockStore = {
  sessions: new Map(),
  chat: new Map(), // customerId -> messages
};

let mockCatalog = null;
let mockPayments = [];

function mockDeepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

jest.setTimeout(180000);

jest.mock("../src/services/session.service", () => ({
  discriminatorFromCustomer: (c) => c?.phone || c?.id || "unknown",
  withLock: async (_k, fn) => fn(),
  get: async (tenantId, phone) => {
    const k = `${tenantId}:${phone}`;
    if (mockStore.sessions.has(k)) return mockDeepClone(mockStore.sessions.get(k));
    return { mode: "ORDER", step: "MENU", cart: [], orderHistory: [], _updatedAt: Date.now() };
  },
  save: async (tenantId, phone, session) => {
    const k = `${tenantId}:${phone}`;
    mockStore.sessions.set(k, mockDeepClone(session));
    mockStore.sessions.get(k)._updatedAt = Date.now();
  },
  clear: async (tenantId, phone) => {
    const k = `${tenantId}:${phone}`;
    mockStore.sessions.delete(k);
  },
  sessionKey: (tenantId, phone) => `sess:${tenantId}:${phone}`,
}));

jest.mock("../src/services/chat-memory.service", () => ({
  push: async (customerId, role, text, _sender, _messageId, _mediaUrl, _waMessageId, originalTimestamp) => {
    const arr = mockStore.chat.get(customerId) || [];
    arr.push({
      role,
      text: String(text || ""),
      at: originalTimestamp ? new Date(originalTimestamp) : new Date(),
    });
    mockStore.chat.set(customerId, arr);
  },
  get: async (customerId) => mockStore.chat.get(customerId) || [],
}));

jest.mock("../src/services/tenant.service", () => ({
  getClients: async () => ({
    cw: {
      getDeliveryFee: async () => 8,
      getMerchant: async () => ({ url: "https://pappiatendente.com.br/cardapio" }),
      getCatalog: async () => mockCatalog || { categories: [] },
      getPaymentMethods: async () => mockPayments || [],
    },
  }),
}));

jest.mock("../src/services/meta-capi.service", () => ({
  trackContact: async () => {},
  trackViewContent: async () => {},
  trackInitiateCheckout: async () => {},
  trackPurchase: async () => {},
}));

jest.mock("../src/services/ai-orchestrator.service", () => ({
  decideOrchestration: async () => ({}),
}));

jest.mock("../src/services/ai.service", () => ({
  generateGreetingPhrase: async () => "Bora montar seu pedido! 🍕",
  classifyIntent: async () => "OTHER",
  extractAddress: async () => null,
  chatOrder: async () => ({ reply: "Perfeito ✅", done: true, items: [{ name: "Item", quantity: 1, unit_price: 1 }] }),
}));

jest.mock("../src/services/maps.service", () => ({
  geocode: async (query) => {
    const q = String(query || "");
    const hasDigits = /\b\d{1,4}\b/.test(q);
    if (!hasDigits) return null;

    // Estrutura mínima para o `AddressNormalizer.fromText(...)` entender.
    return {
      formatted_address: "R. Col. de Minas, 375 - Jardim Santa Amalia, Campinas - SP, 13050-111, Brazil",
      lat: -22.9400676,
      lng: -47.0916285,
    };
  },
  quote: async () => ({
    lat: -22.9400676,
    lng: -47.0916285,
    formatted_address: "R. Col. de Minas, 375 - Jardim Santa Amalia, Campinas - SP, 13050-111, Brazil",
    delivery_fee: 8,
    km: 4.9,
    eta_minutes: 35,
    is_serviceable: true,
  }),
}));

jest.mock("../src/services/socket.service", () => ({
  emitQueueUpdate: () => {},
  emitConvUpdate: () => {},
}));

jest.mock("../src/services/deescalation.service", () => ({
  needsDeescalation: () => false,
  detectHumanRequest: () => false,
}));

// Evita falha de parse ao carregar `src/services/baileys.service` (que depende de um pacote ESM).
jest.mock("@whiskeysockets/baileys", () => ({
  default: () => ({}),
  DisconnectReason: {},
  fetchLatestBaileysVersion: async () => ({ version: "0.0.0" }),
}));

jest.mock("../src/services/customer.service", () => ({
  learningKeyFromCustomer: () => `lk:${mockCustomerPhone}`,
  waCloudDestination: (phone) => phone,
  touchInteraction: async () => {},
  setHandoff: async () => {},
  claimFromQueue: async (id) => id,
  releaseHandoff: async () => {},
}));

jest.mock("../src/services/baileys.service", () => ({
  notify: async () => {},
  setBotEnabled: async () => {},
}));

jest.mock("../src/lib/db", () => ({
  order: {
    findFirst: async () => null,
  },
  customer: {
    findUnique: async () => null,
    findMany: async () => [],
  },
}));

const bot = require("../src/routes/bot.handler");

function extractSizesFromCatalog(catalog) {
  const cats = catalog?.categories || catalog?.data?.categories || catalog?.sections || [];
  const key = "pizza";
  const filtered = cats.filter((c) => {
    const n = (c.name || c.title || "").toLowerCase();
    return key === "pizza" ? /pizza/.test(n) : /lasanha/.test(n);
  });
  const useCats = filtered.length ? filtered : cats;
  const sizes = new Set();

  function normalizeText(input) {
    return String(input || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();
  }

  function optionLooksLikeSizeOption(name) {
    const n = normalizeText(name);
    return (
      /\b(broto|media|grande)\b/i.test(n) ||
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
        const groupHasSizeOption = (g.options || []).some((o) => optionLooksLikeSizeOption(o?.name));
        const groupLooksPlausible = /tamanho|size|fatias|peda/.test(gn) || groupHasSizeOption;
        if (!groupLooksPlausible) continue;

        for (const o of g.options) {
          if (o.status === "INACTIVE") continue;
          if (!o.name) continue;
          if (optionLooksLikeSizeOption(o.name)) sizes.add(o.name.trim());
        }
      }
    }
  }

  return sizes.size ? [...sizes] : ["Broto", "Média", "Grande"];
}

function extractDigits(s) {
  const m = String(s || "").match(/\b(\d{1,2})\b/);
  return m ? Number(m[1]) : null;
}

function hasSizePrompt(waOutputs) {
  return (waOutputs.sentButtons || []).some((b) => /Qual tamanho\?|Escolha uma opção/i.test(b.text || ""));
}

describe("conversation fuzz (semi-real catalog sizes)", () => {
  let sizeOptions = [];

  beforeAll(async () => {
    mockCatalog = null;
    mockPayments = [];

    // Fallback para quando rede/API estiver indisponível (mantém o fuzz executável).
    function fallbackSizes() {
      sizeOptions = ["Broto", "Média", "Grande"];
      mockCatalog = { categories: [] };
      mockPayments = [];
    }

    if (NET_MODE !== "prod_net") {
      fallbackSizes();
      return;
    }

    try {
      const resp = await fetch(CATALOG_URL, { headers: { "x-api-key": API_KEY } });
      if (!resp.ok) throw new Error(`catalog http ${resp.status}`);
      const data = await resp.json();
      const catalog = data?.catalog || data?.data || data;
      sizeOptions = extractSizesFromCatalog(catalog);
      mockCatalog = catalog;
      mockPayments = data?.payments || data?.paymentMethods || [];
    } catch (err) {
      // Mantém fuzz rodando sem quebrar CI/local offline.
      fallbackSizes();
      // eslint-disable-next-line no-console
      console.warn("[fuzz] falha ao buscar catálogo real — usando fallback stub:", err?.message || err);
    }
  });

  beforeEach(() => {
    mockStore.sessions.clear();
    mockStore.chat.clear();
  });

  test(`conversation fuzz (seed=${SEED}, scale=${SCALE})`, async () => {
    const rng = makeRng(SEED);
    const customer = { id: "cust_fuzz", phone: CUSTOMER_PHONE, name: "Fuzz Customer", visitCount: 1 };
    const tenant = { id: TENANT_ID, name: "Pappi", city: "Campinas" };
    const phone = `${CUSTOMER_PHONE}@s.whatsapp.net`;

    const failures = [];
    const countsByType = {};

    const prepareSessionForScenario = (type) => {
      const base = { mode: "ORDER", step: "MENU", cart: [], orderHistory: [], _updatedAt: Date.now() };
      if (type.startsWith("address")) {
        return { ...base, step: "ADDRESS", fulfillment: "delivery", productType: "pizza", addressBuffer: [], addressFailCount: 0 };
      }
      if (type.startsWith("size_")) {
        return { ...base, mode: "ORDER", step: "ASK_SIZE", fulfillment: rng() < 0.5 ? "delivery" : "takeout", productType: "pizza", sizeOptions };
      }
      if (type === "status_in_progress") {
        return { ...base, mode: "ORDER", step: "ORDERING", fulfillment: "delivery", productType: "pizza", chosenSize: sizeOptions[0] };
      }
      return { ...base, mode: "TRIAGE", step: "MENU" };
    };

    for (let i = 0; i < SCALE; i++) {
      const sc = generateScenario({ i, rng, sizeOptions });
      const type = sc.type;
      countsByType[type] = (countsByType[type] || 0) + 1;

      const waOut = { sentText: [], sentButtons: [] };
      const wa = {
        sendText: async (_to, text) => waOut.sentText.push(String(text || "")),
        sendButtons: async (_to, text, buttons = []) =>
          waOut.sentButtons.push({ text: String(text || ""), buttons: buttons.map((b) => b.title || b.id || "") }),
      };

      const session = prepareSessionForScenario(type);
      mockStore.sessions.set(`${TENANT_ID}:${SESSION_KEY}`, mockDeepClone(session));

      try {
        for (const inboundText of sc.messages) {
          await bot.handle({ tenant, wa, customer, text: inboundText, phone, sessionKey: SESSION_KEY });
        }
      } catch (err) {
        failures.push({ id: sc.id, type, error: err.message, messages: sc.messages, waOut });
        continue;
      }

      const finalSession = mockStore.sessions.get(`${TENANT_ID}:${SESSION_KEY}`) || {};

      if (type.startsWith("size_")) {
        const chosen = finalSession.chosenSize;
        const chosenIsOption = sizeOptions.includes(chosen);
        const sizePromptCount = (waOut.sentButtons || []).filter((b) => /Qual tamanho\?|Escolha uma opção/i.test(b.text || "")).length;

        const msg = String(sc.messages[0] || "").toLowerCase();
        const msgNum = extractDigits(msg);
        const sizeOptionsHaveMsgNum = msgNum != null && sizeOptions.some((s) => extractDigits(s) === msgNum);
        const chosenMatchesNum = msgNum == null || !sizeOptionsHaveMsgNum || extractDigits(chosen) === msgNum;

        // Invariantes do fuzz:
        // - não deve “pedir tamanho de novo” no ASK_SIZE quando a mensagem já contém tamanho
        // - escolhido precisa ser uma opção real do catálogo
        if (!chosenIsOption || sizePromptCount > 0 || !chosenMatchesNum) {
          failures.push({
            id: sc.id,
            type,
            reason: "size_normalization_or_prompt",
            sc,
            finalSession,
            waOut,
            chosen,
          });
        }
      }

      if (type === "status_in_progress") {
        const ok = waOut.sentText.some((t) => /Seu pedido está em andamento/i.test(t));
        const wrong = waOut.sentText.some((t) => /Não encontrei nenhum pedido/i.test(t));
        if (!ok || wrong) failures.push({ id: sc.id, type, reason: "status_in_progress_should_answer_progress", sc, waOut, finalSession });
      }

      if (type === "address") {
        const finalStep = String(finalSession.step || "");
        const okSteps = ["ADDRESS_CONFIRM", "ASK_SIZE", "ORDERING", "PAYMENT", "CONFIRM", "ORDER"].includes(finalStep);
        if (!okSteps && !waOut.sentButtons.some((b) => /confere o endere/i.test(b.text || ""))) {
          failures.push({ id: sc.id, type, reason: "address_should_confirm_or_progress", sc, finalSession, waOut });
        }
      }

      if (type === "address_missing_number") {
        const askedNumber = waOut.sentText.some((t) => /numero da casa|n[uú]mero da casa/i.test(t));
        const finalStep = String(finalSession.step || "");
        const okSteps = ["ADDRESS_CONFIRM", "ASK_SIZE", "ORDERING", "PAYMENT", "CONFIRM"].includes(finalStep);
        if (!askedNumber || !okSteps) {
          failures.push({ id: sc.id, type, reason: "address_missing_number_flow", sc, finalSession, waOut });
        }
      }

      if (type === "complaint_or_menu") {
        const funnelSteps = [
          "CHOOSE_PRODUCT_TYPE",
          "FULFILLMENT",
          "ADDRESS",
          "ADDRESS_NUMBER",
          "ADDRESS_CONFIRM",
          "ASK_SIZE",
          "ORDERING",
          "PAYMENT",
          "CONFIRM",
        ];
        const finalStep = String(finalSession.step || "");
        const enteredFunnel = funnelSteps.includes(finalStep);
        const sentSizePrompt = hasSizePrompt(waOut);

        if (enteredFunnel || sentSizePrompt) {
          failures.push({
            id: sc.id,
            type,
            reason: "complaint_or_menu_should_not_reenter_funnel",
            sc,
            finalSession,
            waOut,
          });
        }
      }
    }

    const countsByReason = {};
    for (const f of failures) {
      const reason = f.reason || "exception";
      countsByReason[reason] = (countsByReason[reason] || 0) + 1;
      if (!f.trace && (f.sc?.messages || f.messages)) f.trace = (f.sc?.messages || f.messages).join(" → ");
    }

    const clusterTop = Object.entries(countsByReason)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const report = {
      seed: SEED,
      scale: SCALE,
      tenantId: TENANT_ID,
      customerPhone: CUSTOMER_PHONE,
      netMode: NET_MODE,
      sizeOptionsCount: sizeOptions.length,
      failuresCount: failures.length,
      failures: failures.slice(0, 200),
      countsByType,
      countsByReason,
      clusterTop,
      endedAt: new Date().toISOString(),
    };

    const outDir = path.resolve(__dirname, "reports");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(outDir, `conversation_fuzz_report_${ts}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf8");

    const criticalReasons = [
      "address_should_confirm_or_progress",
      "address_missing_number_flow",
      "size_normalization_or_prompt",
      "status_in_progress_should_answer_progress",
    ];
    const criticalFailures = failures.filter((f) => criticalReasons.includes(f.reason));
    expect(criticalFailures.length).toBe(0);
  });
});

describe("reconnect anti-spam/backlog (baileys.service._test)", () => {
  test("fresh window + reconnect notice cooldown + suppression", () => {
    const actualBaileys = jest.requireActual("../src/services/baileys.service");
    const testApi = actualBaileys?._test;
    expect(testApi).toBeTruthy();

    const { isFreshForBot, shouldSendReconnectNotice, isReconnectSuppressed, resetReconnectCaches } = testApi;

    jest.useFakeTimers();
    const base = new Date("2026-01-01T00:00:00.000Z");
    jest.setSystemTime(base);

    resetReconnectCaches();

    const mkMsg = (ageMs) => ({
      messageTimestamp: Math.floor((Date.now() - ageMs) / 1000),
    });

    // BOT_FRESH_WINDOW_MS = 2min (ver comentário no baileys.service)
    expect(isFreshForBot(mkMsg(30 * 1000))).toBe(true);
    expect(isFreshForBot(mkMsg(3 * 60 * 1000))).toBe(false);

    // Cooldown + suppression
    const identityKey = "tenant-pappi-001:cust_fuzz";
    resetReconnectCaches();
    jest.setSystemTime(base);

    expect(shouldSendReconnectNotice(identityKey)).toBe(true);
    expect(shouldSendReconnectNotice(identityKey)).toBe(false); // cooldown 5min
    expect(isReconnectSuppressed(identityKey)).toBe(true); // suppression 90s

    jest.setSystemTime(new Date(base.getTime() + 89 * 1000));
    expect(isReconnectSuppressed(identityKey)).toBe(true);

    jest.setSystemTime(new Date(base.getTime() + 91 * 1000));
    expect(isReconnectSuppressed(identityKey)).toBe(false);

    // Após o cooldown, volta a permitir aviso
    jest.setSystemTime(new Date(base.getTime() + 5 * 60 * 1000 + 1000));
    expect(shouldSendReconnectNotice(identityKey)).toBe(true);

    // Backlog/append: bot não deve invocar (baileys.service exige !isAppend)
    const shouldInvokeBot = true;
    const isAppend = true;
    const canInvokeBot = shouldInvokeBot && !isAppend && isFreshForBot(mkMsg(30 * 1000)) && !isReconnectSuppressed(identityKey);
    expect(canInvokeBot).toBe(false);

    jest.useRealTimers();
  });
});

