// src/services/order.service.js
// Req 3 — Idempotência com order_id único
// Req 5 — Snapshot completo dos itens do pedido

const prisma = require("../lib/db");
const { validate: validateTotal } = require("../calculators/OrderCalculator");

async function createWithIdempotency(opts) {
  const {
    tenantId,
    customerId,
    idempotencyKey,
    items,
    total,
    fulfillment,
    address,
    paymentMethodId,
    paymentMethodName,
    deliveryFee = 0,
    discount = 0,
    cwOrderId,
    cwPayload,
    cwResponse,
  } = opts;

  const existing = await prisma.order.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
  });
  if (existing) return { order: existing, created: false };

  const validation = validateTotal({ items, declaredTotal: total, deliveryFee, discount });
  if (!validation.ok) {
    console.warn(`[order] Total divergente (esperado ${validation.expected}, declarado ${validation.declared})`);
  }

  const itemsSnapshot = JSON.stringify(items);
  const addressSnapshot = address ? JSON.stringify(address) : null;

  const order = await prisma.order.create({
    data: {
      tenantId,
      customerId,
      idempotencyKey,
      status: "waiting_confirmation",
      total,
      deliveryFee,
      discount,
      totalValidated: validation.ok,
      totalExpected: validation.expected,
      fulfillment,
      paymentMethodId: paymentMethodId || null,
      paymentMethodName: paymentMethodName || null,
      itemsSnapshot,
      addressSnapshot,
      cwOrderId: cwOrderId || null,
      cwPayload: cwPayload ? JSON.stringify(cwPayload) : null,
      cwResponse: cwResponse ? JSON.stringify(cwResponse) : null,
    },
  });

  return { order, created: true };
}

async function updateStatus(orderId, status, source = "system", note = null) {
  const [order] = await prisma.$transaction([
    prisma.order.update({ where: { id: orderId }, data: { status } }),
    prisma.orderStatusLog.create({ data: { orderId, status, source, note } }),
  ]);
  return order;
}

async function setCwOrderId(orderId, cwOrderId, cwResponse = null) {
  return prisma.order.update({
    where: { id: orderId },
    data: {
      cwOrderId,
      cwResponse: cwResponse ? JSON.stringify(cwResponse) : undefined,
    },
  });
}

async function findByCwOrderId(tenantId, cwOrderId) {
  return prisma.order.findFirst({
    where: { tenantId, cwOrderId },
    include: { customer: true },
  });
}

async function findByCustomer(customerId, limit = 5) {
  return prisma.order.findMany({
    where: { customerId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

// Busca pedidos que falharam no CW (sem cwOrderId) para reprocessamento
async function findFailedCwOrders(tenantId, limit = 20) {
  return prisma.order.findMany({
    where: {
      tenantId,
      cwOrderId: null,
      status: { notIn: ["cancelled", "delivered"] },
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // últimas 24h
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    include: { customer: true },
  });
}

module.exports = {
  createWithIdempotency,
  updateStatus,
  setCwOrderId,
  findByCwOrderId,
  findByCustomer,
  findFailedCwOrders,
};
