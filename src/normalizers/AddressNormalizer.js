// src/normalizers/AddressNormalizer.js

const STATES = new Set([
  "AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS",
  "MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC",
  "SP","SE","TO",
]);

function normalize(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, address: null, errors: ["Endereço inválido"] };

  const errors = [];
  const street       = clean(raw.street || raw.rua || raw.logradouro || raw.address || "");
  if (!street) errors.push("Rua obrigatória");

  const number       = clean(raw.number || raw.numero || raw.num || raw.house_number || "S/N");
  const complement   = clean(raw.complement || raw.complemento || raw.comp || "");
  const neighborhood = clean(raw.neighborhood || raw.bairro || raw.district || "");
  if (!neighborhood) errors.push("Bairro obrigatório");

  const city = clean(raw.city || raw.cidade || raw.town || "");
  if (!city) errors.push("Cidade obrigatória");

  const stateRaw = clean(raw.state || raw.estado || raw.uf || "");
  const state    = stateRaw.toUpperCase().slice(0, 2);
  if (state && !STATES.has(state)) errors.push(`UF inválida: ${state}`);

  const zipRaw  = String(raw.zipCode || raw.zip_code || raw.cep || "").replace(/\D/g, "");
  const zipCode = zipRaw.length === 8 ? zipRaw : zipRaw.padStart(8, "0").slice(-8);
  if (zipRaw && zipCode.length !== 8) errors.push("CEP inválido");

  const parts = [street, number];
  if (complement) parts.push(complement);
  parts.push(neighborhood);
  if (city)    parts.push(city);
  if (state)   parts.push(state);
  if (zipCode) parts.push(zipCode.replace(/(\d{5})(\d{3})/, "$1-$2"));
  const formatted = parts.join(", ");

  if (errors.length > 0) return { ok: false, address: null, errors };
  return { ok: true, errors: [], address: { street, number, complement, neighborhood, city, state, zipCode, formatted } };
}

function fromText(text) {
  if (!text || typeof text !== "string") return null;
  const t        = text.trim();
  const cepMatch = t.match(/\b(\d{5})-?(\d{3})\b/);
  const zipCode  = cepMatch ? cepMatch[1] + cepMatch[2] : "";
  const numMatch = t.match(/[,\s]+n[°º\.]?\s*(\d+\S*)/i) || t.match(/,\s*(\d+[A-Za-z]*)\b/);
  const number   = numMatch ? numMatch[1] : "S/N";
  const street   = t.split(",")[0].trim();
  return { street, number, zipCode, city: "", neighborhood: "", state: "", complement: "" };
}

function clean(v) { return String(v || "").trim().replace(/\s+/g, " "); }

module.exports = { normalize, fromText };
