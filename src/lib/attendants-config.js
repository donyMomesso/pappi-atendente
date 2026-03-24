// src/lib/attendants-config.js
// Normalização e validação de atendentes (nome + e-mail obrigatórios para relatório).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

function normalizeAttendantRecord(raw) {
  if (raw == null) return null;
  if (typeof raw === "string") {
    const name = String(raw).trim();
    return { name, email: "", role: "attendant" };
  }
  const name = String(raw.name || "").trim();
  const email = String(raw.email || "").trim().toLowerCase();
  const role = raw.role === "admin" ? "admin" : "attendant";
  const key = raw.key != null && String(raw.key).trim() ? String(raw.key).trim() : undefined;
  return { name, email, role, ...(key ? { key } : {}) };
}

function parseAttendantsJson(value) {
  if (!value) return [];
  try {
    const arr = JSON.parse(value);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function normalizeAttendantsList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(normalizeAttendantRecord).filter((a) => a && a.name);
}

function validateAttendantsForSave(list) {
  const normalized = normalizeAttendantsList(list);
  for (let i = 0; i < normalized.length; i++) {
    const a = normalized[i];
    if (!a.name) return { ok: false, error: `Atendente ${i + 1}: nome obrigatório.` };
    if (!a.email || !EMAIL_RE.test(a.email)) {
      return { ok: false, error: `Atendente "${a.name}": e-mail obrigatório e válido (para relatório).` };
    }
  }
  return { ok: true, normalized };
}

/** Mapa nome (trim, lower) -> email — para enriquecer mensagens antigas no relatório */
function emailByNameMap(list) {
  const m = new Map();
  for (const a of normalizeAttendantsList(list)) {
    if (a.name && a.email) m.set(a.name.trim().toLowerCase(), a.email);
  }
  return m;
}

module.exports = {
  EMAIL_RE,
  normalizeAttendantRecord,
  parseAttendantsJson,
  normalizeAttendantsList,
  validateAttendantsForSave,
  emailByNameMap,
};
