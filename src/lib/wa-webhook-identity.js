// Parser resiliente de identidade WhatsApp Cloud (wa_id, BSUID, username, perfil).
// Webhooks variam por versão da API; todos os campos são opcionais.

const PhoneNormalizer = require("../normalizers/PhoneNormalizer");

function looksLikeBsuid(s) {
  if (s == null || typeof s !== "string") return false;
  const t = s.trim();
  if (!t) return false;
  return /^[A-Za-z]{2}\.[A-Za-z0-9._-]+$/.test(t);
}

/** Escolhe contato do array `contacts` mais compatível com a mensagem. */
function pickContact(contacts, rawFrom, msgUserId) {
  if (!Array.isArray(contacts) || contacts.length === 0) return null;
  const uid = msgUserId != null ? String(msgUserId) : null;
  if (uid) {
    const byUid = contacts.find((c) => c?.user_id != null && String(c.user_id) === uid);
    if (byUid) return byUid;
  }
  if (rawFrom != null && String(rawFrom)) {
    const rf = String(rawFrom);
    const byWa = contacts.find((c) => c?.wa_id != null && String(c.wa_id) === rf);
    if (byWa) return byWa;
  }
  return null;
}

/**
 * @param {object} p
 * @param {object} p.msg — objeto message do webhook
 * @param {object[]} [p.contacts]
 * @param {boolean} [p.isEcho]
 * @returns {{ rawWaId: string|null, normalizedPhone: string|null, waUserId: string|null, parentUserId: string|null, username: string|null, profileName: string|null }}
 */
function parseWhatsAppMessageIdentity({ msg, contacts = [], isEcho = false } = {}) {
  const rawFromEcho = isEcho ? msg?.to || msg?.recipient_id || msg?.from : null;
  const rawInbound = !isEcho ? msg?.from : null;
  const raw = String((isEcho ? rawFromEcho : rawInbound) || msg?.from || "").trim() || null;

  let normalizedPhone = raw ? PhoneNormalizer.normalize(raw) : null;
  const msgUserId = msg?.user_id != null ? String(msg.user_id).trim() || null : null;

  const card = pickContact(contacts, raw, msgUserId || (raw && looksLikeBsuid(raw) ? raw : null));
  const cardMatchesFrom = !!card;

  let waUserId = msgUserId || null;
  if (!waUserId && cardMatchesFrom && card?.user_id != null) waUserId = String(card.user_id).trim() || null;
  if (!waUserId && raw && looksLikeBsuid(raw)) waUserId = raw;

  // wa_id “verdadeiro” do evento é msg.from / recipient; cartão só enriquece perfil
  const rawWaId = raw || (card?.wa_id != null ? String(card.wa_id).trim() || null : null);

  if (!normalizedPhone && rawWaId) normalizedPhone = PhoneNormalizer.normalize(rawWaId);

  const parentUserId =
    (cardMatchesFrom && card?.parent_user_id != null ? String(card.parent_user_id).trim() : null) ||
    (msg?.parent_user_id != null ? String(msg.parent_user_id).trim() : null) ||
    null;

  let username = null;
  if (cardMatchesFrom && card?.username != null) username = String(card.username).trim() || null;
  else if (cardMatchesFrom && card?.profile?.username != null)
    username = String(card.profile.username).trim() || null;

  let profileName = null;
  if (cardMatchesFrom && card?.profile?.name != null) profileName = String(card.profile.name).trim() || null;

  return {
    rawWaId: rawWaId || null,
    normalizedPhone: normalizedPhone || null,
    waUserId: waUserId || null,
    parentUserId,
    username,
    profileName,
  };
}

module.exports = {
  looksLikeBsuid,
  parseWhatsAppMessageIdentity,
  pickContact,
};
