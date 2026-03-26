// src/services/customer.service.js

const prisma = require("../lib/db");
const PhoneNormalizer = require("../normalizers/PhoneNormalizer");
const convState = require("./conversation-state.service");
const sessionService = require("./session.service");

function inferIdentityType({ phone, waUserId, username }) {
  const hasP = !!phone;
  const hasU = !!waUserId;
  const hasN = !!username;
  if (hasP && hasU) return "mixed";
  if (hasU) return "wa_user";
  if (hasP) return "phone";
  if (hasN) return "username";
  return "unknown";
}

/** Chave estável para aprendizado / perfis em Config (não é só telefone). */
function learningKeyFromCustomer(customer) {
  if (!customer) return null;
  const p = customer.phone != null ? String(customer.phone).trim() : "";
  if (p) return p;
  const uid = customer.waUserId != null ? String(customer.waUserId).trim() : "";
  if (uid) return `wauser:${uid}`;
  return `cid:${customer.id}`;
}

/**
 * Destino para envio WhatsApp Cloud API: dígitos em `to` OU objeto com BSUID.
 * @param {import("@prisma/client").Customer} customer
 * @returns {string | { recipientUserId: string }}
 */
/**
 * Destino para envio via Baileys: dígitos (E.164 sem +) ou JID completo (@s.whatsapp.net / @lid).
 * @param {import("@prisma/client").Customer | null | undefined} customer
 * @returns {string | null}
 */
function baileysChatTarget(customer) {
  if (!customer) return null;
  const p = customer.phone != null ? String(customer.phone).replace(/\D/g, "") : "";
  if (p.length >= 10 && p.length <= 15) return p;
  const wa = customer.waId != null ? String(customer.waId).trim() : "";
  if (wa.includes("@lid") || wa.endsWith("@s.whatsapp.net")) return wa;
  return p.length >= 8 ? p : null;
}

function waCloudDestination(customer) {
  if (!customer) throw new Error("Cliente ausente — sem destino WhatsApp Cloud.");
  const raw = customer.phone != null ? String(customer.phone).trim() : "";
  if (raw && !raw.includes(":")) {
    const digits = raw.replace(/\D/g, "");
    const n = PhoneNormalizer.normalize(raw) || (digits.length >= 10 ? digits : "");
    if (n && n.length >= 12) return n;
    // Fallback: número BR sem normalização completa — força DDI 55 (Cloud API espera E.164 sem +)
    if (digits.length >= 10 && digits.length <= 11 && !digits.startsWith("55")) {
      return `55${digits}`;
    }
    if (digits.length >= 12) return digits;
  }
  const uid = customer.waUserId != null ? String(customer.waUserId).trim() : "";
  if (uid) return { recipientUserId: uid };
  throw new Error(
    "Cliente sem telefone (wa_id) nem wa_user_id — impossível enviar pela WhatsApp Cloud API. " +
      "Associe um número ou aguarde BSUID no cadastro.",
  );
}

/**
 * @param {object} p
 * @param {string} p.tenantId
 * @param {string|null} [p.normalizedPhone]
 * @param {string|null} [p.rawWaId]
 * @param {string|null} [p.waUserId]
 * @param {string|null} [p.parentUserId]
 * @param {string|null} [p.username]
 * @param {string|null} [p.profileName]
 */
async function findOrCreateContactByIdentity({
  tenantId,
  normalizedPhone = null,
  rawWaId = null,
  waUserId = null,
  parentUserId = null,
  username = null,
  profileName = null,
}) {
  const uid = waUserId != null ? String(waUserId).trim() || null : null;
  const wa = rawWaId != null ? String(rawWaId).trim() || null : null;
  const uname = username != null ? String(username).trim() || null : null;
  const phone = normalizedPhone != null ? String(normalizedPhone).trim() || null : null;

  if (!tenantId) throw new Error("tenantId obrigatório");
  if (!uid && !phone && !wa) {
    throw new Error("Identidade WhatsApp ausente: informe wa_user_id, telefone ou wa_id.");
  }

  let customer = null;
  if (uid) {
    customer = await prisma.customer.findFirst({ where: { tenantId, waUserId: uid } });
  }
  if (!customer && phone) {
    customer = await prisma.customer.findUnique({ where: { tenantId_phone: { tenantId, phone } } });
  }
  if (!customer && wa) {
    customer = await prisma.customer.findFirst({ where: { tenantId, waId: wa } });
  }

  const identityType = inferIdentityType({ phone, waUserId: uid, username: uname });

  if (customer) {
    const data = {};
    if (uid && customer.waUserId !== uid) data.waUserId = uid;
    if (phone && !customer.phone) data.phone = phone;
    if (phone && customer.phone && customer.phone !== phone) data.phone = phone;
    if (wa && !customer.waId) data.waId = wa;
    if (wa && customer.waId && customer.waId !== wa) data.waId = wa;
    if (uname && !customer.waUsername) data.waUsername = uname;
    if (parentUserId && !customer.waParentUserId) data.waParentUserId = parentUserId;
    if (profileName?.trim() && !customer.name) data.name = profileName.trim();
    if (identityType && customer.identityType !== identityType) data.identityType = identityType;
    if (Object.keys(data).length) {
      customer = await prisma.customer.update({ where: { id: customer.id }, data });
    }
    return customer;
  }

  const createData = {
    tenantId,
    phone: phone || null,
    waId: wa || null,
    waUserId: uid || null,
    waParentUserId: parentUserId?.trim() || null,
    waUsername: uname || null,
    identityType: identityType || "unknown",
    name: profileName?.trim() || null,
  };

  try {
    customer = await prisma.customer.create({ data: createData });
  } catch (e) {
    if (e.code === "P2002") {
      return findOrCreateContactByIdentity({
        tenantId,
        normalizedPhone: phone,
        rawWaId: wa,
        waUserId: uid,
        parentUserId,
        username: uname,
        profileName,
      });
    }
    throw e;
  }

  try {
    if (phone) {
      const gc = require("./google-contacts.service");
      gc.createContact(createData.name || null, phone).catch(() => {});
    }
  } catch {}

  return customer;
}

/** @deprecated use findOrCreateContactByIdentity; mantido p/ Baileys e chamadas antigas */
async function findOrCreate(tenantId, rawPhone, name = null) {
  const phone = PhoneNormalizer.normalize(rawPhone);
  if (!phone) throw new Error(`Telefone inválido: ${rawPhone}`);
  return findOrCreateContactByIdentity({
    tenantId,
    normalizedPhone: phone,
    rawWaId: rawPhone != null ? String(rawPhone) : null,
    waUserId: null,
    profileName: name,
  });
}

async function touchInteraction(customerId, addressData = null) {
  const data = { lastInteraction: new Date() };

  if (addressData) {
    if (addressData.street) data.lastStreet = addressData.street;
    if (addressData.number) data.lastNumber = addressData.number;
    if (addressData.neighborhood) data.lastNeighborhood = addressData.neighborhood;
    if (addressData.complement) data.lastComplement = addressData.complement;
    if (addressData.city) data.lastCity = addressData.city;
    if (addressData.formatted) data.lastAddress = addressData.formatted;
    if (addressData.lat != null) data.lastLat = addressData.lat;
    if (addressData.lng != null) data.lastLng = addressData.lng;
  }

  return prisma.customer.update({ where: { id: customerId }, data });
}

async function setHandoff(customerId, enabled) {
  const customer = await prisma.customer.update({
    where: { id: customerId },
    data: {
      handoff: enabled,
      handoffAt: enabled ? new Date() : null,
      queuedAt: enabled ? new Date() : null,
      claimedBy: enabled ? undefined : null,
    },
  });
  await convState.setState(customerId, enabled ? convState.STATES.AGUARDANDO_HUMANO : convState.STATES.BOT_ATIVO);
  return customer;
}

async function claimFromQueue(customerId, attendantName) {
  const customer = await prisma.customer.update({
    where: { id: customerId },
    data: { claimedBy: attendantName },
  });
  await convState.setState(customerId, convState.STATES.HUMANO_ATIVO);
  return customer;
}

async function releaseHandoff(customerId) {
  const customer = await prisma.customer.update({
    where: { id: customerId },
    data: { handoff: false, handoffAt: null, queuedAt: null, claimedBy: null },
  });
  await convState.setState(customerId, convState.STATES.BOT_ATIVO);
  return customer;
}

/** Encerra a conversa (não devolve ao robô até nova mensagem do cliente). Limpa sessão para fresh start. */
async function closeConversation(customerId) {
  const customer = await prisma.customer.update({
    where: { id: customerId },
    data: { handoff: false, handoffAt: null, queuedAt: null, claimedBy: null },
  });
  await convState.setState(customerId, convState.STATES.ENCERRADO);
  const part = sessionService.discriminatorFromCustomer(customer);
  await sessionService.clear(customer.tenantId, part);
  return customer;
}

async function recordOrder(customerId, summary, payment = null) {
  return prisma.customer.update({
    where: { id: customerId },
    data: {
      visitCount: { increment: 1 },
      lastOrderSummary: summary,
      preferredPayment: payment || undefined,
    },
  });
}

async function findByPhone(tenantId, rawPhone) {
  const phone = PhoneNormalizer.normalize(rawPhone);
  if (!phone) return null;
  return prisma.customer.findUnique({
    where: { tenantId_phone: { tenantId, phone } },
  });
}

async function findByWaUserId(tenantId, waUserId) {
  const uid = waUserId != null ? String(waUserId).trim() : "";
  if (!uid) return null;
  return prisma.customer.findFirst({ where: { tenantId, waUserId: uid } });
}

async function setName(customerId, name) {
  return prisma.customer.update({ where: { id: customerId }, data: { name } });
}

const BOT_ERROR_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 horas

/**
 * Incrementa contador de erros do bot para o cliente.
 * Se for a 2ª+ vez na janela de 2h, retorna shouldHandoff: true.
 * @returns {{ shouldHandoff: boolean }}
 */
async function incrementBotErrorAndCheckHandoff(customerId) {
  const key = `botError:${customerId}`;
  const now = new Date();
  let cfg = await prisma.config.findUnique({ where: { key } });

  let count = 1;
  let lastAt = now.getTime();
  if (cfg?.value) {
    try {
      const parsed = JSON.parse(cfg.value);
      const age = now.getTime() - (parsed.lastAt || 0);
      if (age < BOT_ERROR_WINDOW_MS) {
        count = (parsed.count || 0) + 1;
      }
      lastAt = now.getTime();
    } catch {
      count = 1;
    }
  }

  const shouldHandoff = count >= 2;
  const value = JSON.stringify({ count: shouldHandoff ? 0 : count, lastAt });

  await prisma.config.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });

  return { shouldHandoff };
}

module.exports = {
  baileysChatTarget,
  findOrCreate,
  findOrCreateContactByIdentity,
  waCloudDestination,
  learningKeyFromCustomer,
  incrementBotErrorAndCheckHandoff,
  touchInteraction,
  setHandoff,
  claimFromQueue,
  releaseHandoff,
  closeConversation,
  recordOrder,
  findByPhone,
  findByWaUserId,
  setName,
};
