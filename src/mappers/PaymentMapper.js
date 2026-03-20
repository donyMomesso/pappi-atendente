// src/mappers/PaymentMapper.js

const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

const KEYWORDS = {
  pix:     ["pix", "pixzinho", "chave pix"],
  credit:  ["crédito", "credito", "cartão crédito", "visa", "master", "elo", "amex", "credi"],
  debit:   ["débito", "debito", "cartão débito", "cartao debito"],
  cash:    ["dinheiro", "especie", "espécie", "troco", "cash", "nota"],
  voucher: ["voucher", "vale", "ticket", "alelo", "sodexo", "vr", "refeição"],
  ifood:   ["ifood", "ifd"],
  online:  ["online", "link", "pague online", "pagamento online"],
};

function setMethods(tenantId, methods) {
  cache.set(tenantId, { methods: methods || [], fetchedAt: Date.now() });
}

function getMethods(tenantId) {
  const entry = cache.get(tenantId);
  if (!entry) return [];
  if (Date.now() - entry.fetchedAt > CACHE_TTL) return [];
  return entry.methods;
}

function map(tenantId, text) {
  const methods    = getMethods(tenantId);
  if (!methods.length) return { id: null, name: null, matched: false, candidates: [] };

  const normalized = normalize(text);

  for (const m of methods) {
    if (normalize(m.name || m.label || "").includes(normalized))
      return { id: m.id, name: m.name || m.label, matched: true, candidates: methods };
  }

  const detectedType = detectType(normalized);
  if (!detectedType) return { id: null, name: null, matched: false, candidates: methods };

  const typeKeywords = KEYWORDS[detectedType];
  for (const m of methods) {
    const mNorm = normalize(m.name || m.label || "");
    if (typeKeywords.some((k) => mNorm.includes(k)))
      return { id: m.id, name: m.name || m.label, matched: true, candidates: methods };
  }

  return { id: null, name: null, matched: false, candidates: methods };
}

function listFormatted(tenantId) {
  const methods = getMethods(tenantId);
  if (!methods.length) return "Consulte os métodos de pagamento disponíveis.";
  return methods.map((m, i) => `${i + 1}. ${m.name || m.label}`).join("\n");
}

function normalize(str) {
  return String(str || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function detectType(text) {
  for (const [type, keywords] of Object.entries(KEYWORDS)) {
    if (keywords.some((k) => text.includes(normalize(k)))) return type;
  }
  return null;
}

module.exports = { setMethods, getMethods, map, listFormatted };
