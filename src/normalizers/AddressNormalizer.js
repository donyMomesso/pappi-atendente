// src/normalizers/AddressNormalizer.js
// Req 10 — Normalizar e validar endereços de entrega

/**
 * Estrutura esperada de endereço normalizado:
 * {
 *   street:       string,   // Rua / Avenida
 *   number:       string,   // Número
 *   complement:   string,   // Apto / Bloco (opcional)
 *   neighborhood: string,   // Bairro
 *   city:         string,   // Cidade
 *   state:        string,   // UF (2 letras)
 *   zipCode:      string,   // CEP (só dígitos, 8 chars)
 *   formatted:    string,   // Linha única para exibição
 * }
 */

const STATES = new Set([
  "AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS",
  "MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC",
  "SP","SE","TO",
]);

/**
 * Normaliza um objeto de endereço vindo de qualquer fonte
 * (WhatsApp, formulário, IA, etc.)
 *
 * @param {object} raw  Objeto com campos de endereço (nomes variados)
 * @returns {{ ok: boolean, address: object|null, errors: string[] }}
 */
function normalize(raw) {
  if (!raw || typeof raw !== "object") {
    return { ok: false, address: null, errors: ["Endereço inválido"] };
  }

  const errors = [];

  // ── street ────────────────────────────────────────────────
  const street = clean(
    raw.street || raw.rua || raw.logradouro || raw.address || ""
  );
  if (!street) errors.push("Rua obrigatória");

  // ── number ────────────────────────────────────────────────
  const number = clean(
    raw.number || raw.numero || raw.num || raw.house_number || "S/N"
  );

  // ── complement ────────────────────────────────────────────
  const complement = clean(
    raw.complement || raw.complemento || raw.comp || ""
  );

  // ── neighborhood ──────────────────────────────────────────
  const neighborhood = clean(
    raw.neighborhood || raw.bairro || raw.district || ""
  );
  if (!neighborhood) errors.push("Bairro obrigatório");

  // ── city ──────────────────────────────────────────────────
  const city = clean(
    raw.city || raw.cidade || raw.town || ""
  );
  if (!city) errors.push("Cidade obrigatória");

  // ── state ─────────────────────────────────────────────────
  const stateRaw = clean(raw.state || raw.estado || raw.uf || "");
  const state = stateRaw.toUpperCase().slice(0, 2);
  if (state && !STATES.has(state)) errors.push(`UF inválida: ${state}`);

  // ── zipCode ───────────────────────────────────────────────
  const zipRaw = String(raw.zipCode || raw.zip_code || raw.cep || "").replace(/\D/g, "");
  const zipCode = zipRaw.length === 8 ? zipRaw : zipRaw.padStart(8, "0").slice(-8);
  if (zipRaw && zipCode.length !== 8) errors.push("CEP inválido");

  // ── formatted ─────────────────────────────────────────────
  const parts = [street, number];
  if (complement) parts.push(complement);
  parts.push(neighborhood);
  if (city) parts.push(city);
  if (state) parts.push(state);
  if (zipCode) parts.push(zipCode.replace(/(\d{5})(\d{3})/, "$1-$2"));
  const formatted = parts.join(", ");

  if (errors.length > 0) {
    return { ok: false, address: null, errors };
  }

  return {
    ok: true,
    errors: [],
    address: { street, number, complement, neighborhood, city, state, zipCode, formatted },
  };
}

/**
 * Tenta extrair estrutura de endereço a partir de uma string livre.
 * Útil quando o cliente digita o endereço como texto.
 * Retorna null se não conseguir extrair o mínimo necessário.
 *
 * @param {string} text
 * @returns {object|null}
 */
function fromText(text) {
  if (!text || typeof text !== "string") return null;

  const t = text.trim();

  // Tenta extrair CEP
  const cepMatch = t.match(/\b(\d{5})-?(\d{3})\b/);
  const zipCode = cepMatch ? cepMatch[1] + cepMatch[2] : "";

  // Tenta extrair número (após vírgula ou espaço)
  const numMatch = t.match(/[,\s]+n[°º\.]?\s*(\d+\S*)/i) || t.match(/,\s*(\d+[A-Za-z]*)\b/);
  const number = numMatch ? numMatch[1] : "S/N";

  // Resto é considerado rua + bairro
  const street = t.split(",")[0].trim();

  return { street, number, zipCode, city: "", neighborhood: "", state: "", complement: "" };
}

function clean(v) {
  return String(v || "").trim().replace(/\s+/g, " ");
}

module.exports = { normalize, fromText };
