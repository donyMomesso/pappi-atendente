// src/services/order.service.js
// Req 3 — Idempotência com order_id único
// Req 5 — Snapshot completo dos itens do pedido

const { PrismaClient } = require("@prisma/client");
const { validate: validateTotal } = require("../calculators/OrderCalculator");

const prisma = new PrismaClient();

/**
 * Cria um pedido local com idempotência.
 * Se já existir um pedido com o mesmo idempotencyKey para o tenant,
 * retorna o existente sem criar duplicata.
 *
 * @param {object} opts
 * @param {string} opts.tenantId
 * @param {string} opts.customerId
 * @param {string} opts.idempotencyKey    Hash ou UUID gerado pelo bot
 * @param {Array}  opts.items             Itens do pedido
 * @param {number} opts.total             Total declarado (do CW)
 * @param {string} opts.fulfillment       "delivery" | "takeout"
 * @param {object} [opts.address]         Endereço normalizado
 * @param {string} [opts.paymentMethodId] ID do método de pagamento CW
 * @param {string} [opts.paymentMethodName]
 * @param {number} [opts.deliveryFee]
 * @param {number} [opts.discount]
 * @param {string} [opts.cwOrderId]       ID retornado pelo CW
 * @param {object} [opts.cwPayload]       JSON enviado ao CW
 * @param {object} [opts.cwResponse]      JSON recebido do CW
 * @returns {{ order, created: boolean }}
 */
async function createWithIdempotency(opts) {
  const {
    tenantId, customerId, idempotencyKey, items, total,
    fulfillment, address, paymentMethodId, paymentMethodName,
    deliveryFee = 0, discount = 0, cwOrderId, cwPayload, cwResponse,
  } = opts;

  // ── Idempotência ─────────────────────────────────────────
  const existing = await prisma.order.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
  });
  if (existing) return { order: existing, created: false };

  // ── Validação de total ────────────────────────────────────
  const validation = validateTotal({ items, declaredTotal: total, deliveryFee, discount });
  if (!validation.ok) {
    console.warn(
      `[order] Total divergente (esperado ${validation.expected}, declarado ${validation.declared})`
    );
  }

  // ── Snapshot completo dos itens ───────────────────────────
  const itemsSnapshot = JSON.stringify(items);
  const addressSnapshot = address ? JSON.stringify(address) : null;

  const order = await prisma.order.create({
    data: {
      tenantId,
      customerId,
      idempotencyKey,
      status:             "waiting_confirmation",
      total,
      deliveryFee,
      discount,
      totalValidated:     validation.ok,
      totalExpected:      validation.expected,
      fulfillment,
      paymentMethodId:    paymentMethodId || null,
      paymentMethodName:  paymentMethodName || null,
      itemsSnapshot,
      addressSnapshot,
      cwOrderId:          cwOrderId || null,
      cwPayload:          cwPayload ? JSON.stringify(cwPayload) : null,
      cwResponse:         cwResponse ? JSON.stringify(cwResponse) : null,
    },
  });

  return { order, created: true };
}

/**
 * Atualiza o status de um pedido.
 * Registra log de auditoria automaticamente.
 *
 * @param {string} orderId      ID interno
 * @param {string} status       Novo status
 * @param {string} [source]     "bot" | "human" | "webhook" | "system"
 * @param {string} [note]
 */
async function updateStatus(orderId, status, source = "system", note = null) {
  const [order] = await prisma.$transaction([
    prisma.order.update({
      where: { id: orderId },
      data: { status },
    }),
    prisma.orderStatusLog.create({
      data: { orderId, status, source, note },
    }),
  ]);
  return order;
}

/**
 * Vincula o ID do pedido no CW a um pedido local.
 */
async function setCwOrderId(orderId, cwOrderId, cwResponse = null) {
  return prisma.order.update({
    where: { id: orderId },
    data: {
      cwOrderId,
      cwResponse: cwResponse ? JSON.stringify(cwResponse) : undefined,
    },
  });
}

/**
 * Busca pedido pelo cwOrderId (para processar webhooks do CW).
 */
async function findByCwOrderId(tenantId, cwOrderId) {
  return prisma.order.findFirst({
    where: { tenantId, cwOrderId },
    include: { customer: true },
  });
}

/**
 * Busca pedidos de um customer.
 */
async function findByCustomer(customerId, limit = 5) {
  return prisma.order.findMany({
    where: { customerId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

module.exports = {
  createWithIdempotency,
  updateStatus,
  setCwOrderId,
  findByCwOrderId,
  findByCustomer,
};
