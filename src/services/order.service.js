// src/services/order.service.js
// Req 3 — Idempotência com order_id único
// Req 5 — Snapshot completo dos itens do pedido

const prisma = require("../lib/db");
const orderPixDbCompat = require("../lib/order-pix-db-compat");
const { validate: validateTotal } = require("../calculators/OrderCalculator");

const selOrder = () => orderPixDbCompat.getOrderScalarSelect();

function mapCwStatusToInternal(status) {
  const s = String(status || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");
  const map = {
    em_producao: "in_preparation",
    in_production: "in_preparation",
    preparando: "in_preparation",
    saiu_para_entrega: "dispatched",
    out_for_delivery: "dispatched",
    pedido_concluido: "concluded",
    delivered: "concluded",
    pronto_para_retirada: "confirmed",
  };
  return map[s] || s || "waiting_confirmation";
}

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
    status: initialStatus,
  } = opts;

  const existing = await prisma.order.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
    select: selOrder(),
  });
  if (existing) return { order: existing, created: false };

  const validation = validateTotal({ items, declaredTotal: total, deliveryFee, discount });
  if (!validation.ok) {
    console.warn(`[order] Total divergente (esperado ${validation.expected}, declarado ${validation.declared})`);
  }

  const itemsSnapshot = JSON.stringify(items);
  const addressSnapshot = address ? JSON.stringify(address) : null;
  const paymentMethodIdNormalized =
    paymentMethodId === undefined || paymentMethodId === null || paymentMethodId === "" ? null : String(paymentMethodId);
  const cwOrderIdNormalized = cwOrderId === undefined || cwOrderId === null || cwOrderId === "" ? null : String(cwOrderId);

  const order = await prisma.order.create({
    select: selOrder(),
    data: {
      tenantId,
      customerId,
      idempotencyKey,
      status: initialStatus || "waiting_confirmation",
      total,
      deliveryFee,
      discount,
      totalValidated: validation.ok,
      totalExpected: validation.expected,
      fulfillment,
      paymentMethodId: paymentMethodIdNormalized,
      paymentMethodName: paymentMethodName || null,
      itemsSnapshot,
      addressSnapshot,
      cwOrderId: cwOrderIdNormalized,
      cwPayload: cwPayload ? JSON.stringify(cwPayload) : null,
      cwResponse: cwResponse ? JSON.stringify(cwResponse) : null,
    },
  });

  return { order, created: true };
}

async function updateStatus(orderId, status, source = "system", note = null) {
  const [order] = await prisma.$transaction([
    prisma.order.update({ where: { id: orderId }, data: { status }, select: selOrder() }),
    prisma.orderStatusLog.create({ data: { orderId, status, source, note } }),
  ]);
  return order;
}

/** Atualiza status vindo do CardápioWeb e campos de monitoramento de atraso */
async function updateCwStatus(orderId, cwStatus) {
  const normalizedRaw = String(cwStatus || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");
  const internalStatus = mapCwStatusToInternal(cwStatus);
  const isDone = ["concluded"].includes(internalStatus);
  const data = {
    status: internalStatus,
    cardapiowebStatus: normalizedRaw,
    statusChangedAt: new Date(),
  };
  if (isDone) {
    data.deliveryRiskLevel = null;
    data.watchedByAttendant = null;
  }
  return prisma.order.update({
    where: { id: orderId },
    data,
    select: selOrder(),
  });
}

async function setCwOrderId(orderId, cwOrderId, cwResponse = null) {
  const cwOrderIdNormalized = cwOrderId === undefined || cwOrderId === null || cwOrderId === "" ? null : String(cwOrderId);
  return prisma.order.update({
    where: { id: orderId },
    data: {
      cwOrderId: cwOrderIdNormalized,
      cwResponse: cwResponse ? JSON.stringify(cwResponse) : undefined,
    },
    select: selOrder(),
  });
}

async function findByCwOrderId(tenantId, cwOrderId) {
  return prisma.order.findFirst({
    where: { tenantId, cwOrderId },
    select: { ...selOrder(), customer: true },
  });
}

async function findOrderByCwOrderIdGlobal(cwOrderId) {
  return prisma.order.findFirst({
    where: { cwOrderId },
    select: { ...selOrder(), customer: true },
  });
}

async function findByCustomer(customerId, limit = 5) {
  return prisma.order.findMany({
    where: { customerId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: selOrder(),
  });
}

// Busca pedidos que falharam no CW (sem cwOrderId) para reprocessamento
async function findFailedCwOrders(tenantId, limit = 20) {
  return prisma.order.findMany({
    where: {
      tenantId,
      cwOrderId: null,
      status: { notIn: ["cancelled", "delivered", "lead"] },
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // últimas 24h
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { ...selOrder(), customer: true },
  });
}

module.exports = {
  createWithIdempotency,
  updateStatus,
  updateCwStatus,
  setCwOrderId,
  findByCwOrderId,
  findOrderByCwOrderIdGlobal,
  findByCustomer,
  findFailedCwOrders,
};
