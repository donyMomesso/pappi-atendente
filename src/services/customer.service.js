// src/services/customer.service.js

const { PrismaClient } = require("@prisma/client");
const PhoneNormalizer = require("../normalizers/PhoneNormalizer");

const prisma = new PrismaClient();

/**
 * Busca ou cria um customer para um tenant.
 * O telefone é sempre normalizado antes de persistir.
 *
 * @param {string} tenantId
 * @param {string} rawPhone   Número em qualquer formato
 * @param {string} [name]     Nome se disponível
 */
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
  } else if (name && !customer.name) {
    customer = await prisma.customer.update({
      where: { id: customer.id },
      data: { name },
    });
  }

  return customer;
}

/**
 * Atualiza a última interação e endereço do customer.
 */
async function touchInteraction(customerId, addressData = null) {
  const data = { lastInteraction: new Date() };

  if (addressData) {
    if (addressData.street)       data.lastStreet       = addressData.street;
    if (addressData.number)       data.lastNumber       = addressData.number;
    if (addressData.neighborhood) data.lastNeighborhood = addressData.neighborhood;
    if (addressData.complement)   data.lastComplement   = addressData.complement;
    if (addressData.city)         data.lastCity         = addressData.city;
    if (addressData.formatted)    data.lastAddress      = addressData.formatted;
    if (addressData.lat != null)  data.lastLat          = addressData.lat;
    if (addressData.lng != null)  data.lastLng          = addressData.lng;
  }

  return prisma.customer.update({ where: { id: customerId }, data });
}

/**
 * Ativa/desativa o modo handoff (humano assumiu a conversa).
 * Ao ativar, entra na fila. Ao desativar, sai da fila e libera o atendente.
 */
async function setHandoff(customerId, enabled) {
  return prisma.customer.update({
    where: { id: customerId },
    data: {
      handoff: enabled,
      handoffAt: enabled ? new Date() : null,
      queuedAt: enabled ? new Date() : null,
      claimedBy: enabled ? undefined : null,
    },
  });
}

/**
 * Atendente assume um cliente da fila.
 */
async function claimFromQueue(customerId, attendantName) {
  return prisma.customer.update({
    where: { id: customerId },
    data: { claimedBy: attendantName },
  });
}

/**
 * Encerra o atendimento humano: volta ao bot e remove da fila.
 */
async function releaseHandoff(customerId) {
  return prisma.customer.update({
    where: { id: customerId },
    data: { handoff: false, handoffAt: null, queuedAt: null, claimedBy: null },
  });
}

/**
 * Incrementa contador de visitas e salva resumo do último pedido.
 */
async function recordOrder(customerId, summary, payment = null) {
  return prisma.customer.update({
    where: { id: customerId },
    data: {
      visitCount:       { increment: 1 },
      lastOrderSummary: summary,
      preferredPayment: payment || undefined,
    },
  });
}

/**
 * Busca customer por tenant + telefone normalizado.
 */
async function findByPhone(tenantId, rawPhone) {
  const phone = PhoneNormalizer.normalize(rawPhone);
  if (!phone) return null;
  return prisma.customer.findUnique({
    where: { tenantId_phone: { tenantId, phone } },
  });
}

module.exports = { findOrCreate, touchInteraction, setHandoff, claimFromQueue, releaseHandoff, recordOrder, findByPhone };
