// src/normalizers/PhoneNormalizer.js
// Req 9 — Normalizar e validar telefones brasileiros (WhatsApp)

/**
 * Normaliza um número de telefone para o formato E.164 sem o "+".
 * Ex: "(11) 9 8765-4321" → "5511987654321"
 *     "11987654321"      → "5511987654321"
 *     "5511987654321"    → "5511987654321"
 *
 * @param {string} raw  Número em qualquer formato
 * @returns {string|null}  Número normalizado ou null se inválido
 */
function normalize(raw) {
  if (!raw) return null;

  // Remove tudo que não é dígito
  const digits = String(raw).replace(/\D/g, "");

  // Remove DDI 55 se vier duplicado (ex: "5555...")
  let local = digits;
  if (local.startsWith("55") && local.length > 13) {
    local = local.slice(2);
  }

  // Adiciona DDI 55 se não tiver
  if (!local.startsWith("55")) {
    local = "55" + local;
  }

  // Valida comprimento: 55 + DDD(2) + número(8 ou 9) = 12 ou 13 dígitos
  if (local.length < 12 || local.length > 13) return null;

  // Valida DDD (11-99)
  const ddd = parseInt(local.slice(2, 4), 10);
  if (ddd < 11 || ddd > 99) return null;

  return local;
}

/**
 * Remove o DDI 55 do número para uso local (ex: CardápioWeb)
 * "5511987654321" → "11987654321"
 */
function toLocal(normalized) {
  if (!normalized) return null;
  const n = normalize(normalized);
  if (!n) return null;
  return n.startsWith("55") ? n.slice(2) : n;
}

/**
 * Formata para exibição: "5511987654321" → "(11) 98765-4321"
 */
function format(normalized) {
  const n = normalize(normalized);
  if (!n) return normalized || "";

  const local = n.slice(2); // remove DDI
  const ddd = local.slice(0, 2);
  const num = local.slice(2);

  if (num.length === 9) {
    return `(${ddd}) ${num.slice(0, 5)}-${num.slice(5)}`;
  }
  if (num.length === 8) {
    return `(${ddd}) ${num.slice(0, 4)}-${num.slice(4)}`;
  }
  return `(${ddd}) ${num}`;
}

/**
 * Extrai o número sem DDI do payload do WhatsApp.
 * O WhatsApp envia "5511987654321" no campo wa_id.
 */
function fromWhatsApp(waId) {
  return normalize(waId);
}

module.exports = { normalize, toLocal, format, fromWhatsApp };
