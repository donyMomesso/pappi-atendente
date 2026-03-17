// src/mappers/PaymentMapper.js
// Req 7 — Mapear métodos de pagamento do CardápioWeb

/**
 * Converte o texto livre que o cliente digita para o ID de pagamento
 * correto da lista do CardápioWeb (payment_methods).
 *
 * Os IDs reais vêm de GET /api/partner/v1/merchant/payment_methods.
 * Nunca inventamos IDs: sempre buscamos do CW e mapeamos por similaridade.
 */

// Cache em memória dos métodos de pagamento (por tenant)
const cache = new Map(); // tenantId → { methods, fetchedAt }
const CACHE_TTL = 10 * 60 * 1000; // 10 minutos

/**
 * Palavras-chave por tipo de pagamento para matching
 */
const KEYWORDS = {
  pix: ["pix", "pixzinho", "chave pix"],
  credit: ["crédito", "credito", "cartão crédito", "visa", "master", "elo", "amex", "credi"],
  debit: ["débito", "debito", "cartão débito", "cartao debito"],
  cash: ["dinheiro", "especie", "espécie", "troco", "cash", "nota"],
  voucher: ["voucher", "vale", "ticket", "alelo", "sodexo", "vr", "refeição"],
  ifood: ["ifood", "ifd"],
  online: ["online", "link", "pague online", "pagamento online"],
};

/**
 * Atualiza o cache de métodos de um tenant.
 * @param {string} tenantId
 * @param {Array}  methods   Array de payment_methods do CW
 */
function setMethods(tenantId, methods) {
  cache.set(tenantId, { methods: methods || [], fetchedAt: Date.now() });
}

/**
 * Retorna os métodos em cache para um tenant (ou [] se expirado/inexistente).
 */
function getMethods(tenantId) {
  const entry = cache.get(tenantId);
  if (!entry) return [];
  if (Date.now() - entry.fetchedAt > CACHE_TTL) return [];
  return entry.methods;
}

/**
 * Encontra o método de pagamento do CW mais próximo do texto do cliente.
 *
 * @param {string} tenantId
 * @param {string} text       Ex: "vou pagar no pix"
 * @returns {{ id: string|null, name: string|null, matched: boolean, candidates: Array }}
 */
function map(tenantId, text) {
  const methods = getMethods(tenantId);
  if (!methods.length) {
    return { id: null, name: null, matched: false, candidates: [] };
  }

  const normalized = normalize(text);

  // 1. Tenta match direto pelo nome do método CW
  for (const m of methods) {
    if (normalize(m.name || m.label || "").includes(normalized)) {
      return { id: m.id, name: m.name || m.label, matched: true, candidates: methods };
    }
  }

  // 2. Identifica tipo pelo texto do cliente
  const detectedType = detectType(normalized);
  if (!detectedType) {
    return { id: null, name: null, matched: false, candidates: methods };
  }

  // 3. Busca na lista do CW um método que corresponda ao tipo detectado
  const typeKeywords = KEYWORDS[detectedType];
  for (const m of methods) {
    const mNorm = normalize(m.name || m.label || "");
    if (typeKeywords.some((k) => mNorm.includes(k))) {
      return { id: m.id, name: m.name || m.label, matched: true, candidates: methods };
    }
  }

  return { id: null, name: null, matched: false, candidates: methods };
}

/**
 * Retorna uma lista formatada dos métodos aceitos para exibir ao cliente.
 */
function listFormatted(tenantId) {
  const methods = getMethods(tenantId);
  if (!methods.length) return "Consulte os métodos de pagamento disponíveis.";
  return methods.map((m, i) => `${i + 1}. ${m.name || m.label}`).join("\n");
}

// ── Helpers ─────────────────────────────────────────────────

function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function detectType(text) {
  for (const [type, keywords] of Object.entries(KEYWORDS)) {
    if (keywords.some((k) => text.includes(normalize(k)))) return type;
  }
  return null;
}

module.exports = { setMethods, getMethods, map, listFormatted };
