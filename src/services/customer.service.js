// src/services/customer.service.js

const prisma = require("../lib/db");
const PhoneNormalizer = require("../normalizers/PhoneNormalizer");
const convState = require("./conversation-state.service");

async function findOrCreate(tenantId, rawPhone, name = null) {
  const phone = PhoneNormalizer.normalize(rawPhone);
  if (!phone) throw new Error(`Telefone inválido: ${rawPhone}`);

  let customer = await prisma.customer.findUnique({
    where: { tenantId_phone: { tenantId, phone } },
  });

  if (!customer) {
    customer = await prisma.customer.create({
      data: { tenantId, phone, name: name || null },
    });
    try {
      const gc = require("./google-contacts.service");
      gc.createContact(name || null, phone).catch(() => {});
    } catch {}
  } else if (name && !customer.name) {
    customer = await prisma.customer.update({
      where: { id: customer.id },
      data: { name },
    });
  }

  return customer;
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
  const sessionService = require("./session.service");
  await sessionService.clear(customer.tenantId, customer.phone);
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
  findOrCreate,
  incrementBotErrorAndCheckHandoff,
  touchInteraction,
  setHandoff,
  claimFromQueue,
  releaseHandoff,
  closeConversation,
  recordOrder,
  findByPhone,
  setName,
};
