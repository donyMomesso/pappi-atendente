// src/normalizers/PhoneNormalizer.js

function normalize(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  let local = digits;
  if (local.startsWith("55") && local.length > 13) local = local.slice(2);
  if (!local.startsWith("55")) local = "55" + local;
  if (local.length < 12 || local.length > 13) return null;
  const ddd = parseInt(local.slice(2, 4), 10);
  if (ddd < 11 || ddd > 99) return null;
  return local;
}

function toLocal(normalized) {
  if (!normalized) return null;
  const n = normalize(normalized);
  if (!n) return null;
  return n.startsWith("55") ? n.slice(2) : n;
}

function format(normalized) {
  const n = normalize(normalized);
  if (!n) return normalized || "";
  const local = n.slice(2);
  const ddd = local.slice(0, 2);
  const num = local.slice(2);
  if (num.length === 9) return `(${ddd}) ${num.slice(0, 5)}-${num.slice(5)}`;
  if (num.length === 8) return `(${ddd}) ${num.slice(0, 4)}-${num.slice(4)}`;
  return `(${ddd}) ${num}`;
}

function fromWhatsApp(waId) {
  return normalize(waId);
}

module.exports = { normalize, toLocal, format, fromWhatsApp };
