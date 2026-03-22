// src/services/coupon.service.js
// Geração de cupons de compensação por atraso.

const prisma = require("../lib/db");
const crypto = require("crypto");
const log = require("../lib/logger").child({ service: "coupon" });

function generateCode(prefix = "BORDA") {
  const hex = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `${prefix}-${hex}`;
}

/**
 * Gera cupom único e salva no pedido.
 * @param {{ orderId: string, type?: string, reason?: string }} opts
 * @returns {{ code: string }|null}
 */
async function generateCompensationCoupon({ orderId, type = "borda_gratis", reason = "atraso" }) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, couponCode: true, tenantId: true },
  });
  if (!order) return null;
  if (order.couponCode) return { code: order.couponCode };

  const code = generateCode("BORDA");
  await prisma.order.update({
    where: { id: orderId },
    data: {
      couponCode: code,
      couponGeneratedAt: new Date(),
      compensationType: type,
      compensationReason: reason,
      compensationEligible: true,
    },
  });
  log.info({ orderId, code, type }, "Cupom de compensação gerado");
  return { code };
}

/**
 * Marca cupom como enviado ao cliente.
 */
async function markCouponSent(orderId) {
  await prisma.order.update({
    where: { id: orderId },
    data: { couponSentAt: new Date() },
  });
}

/**
 * Valida se um cupom existe e está vinculado a um pedido (para uso futuro no checkout).
 */
async function validateCoupon(tenantId, code) {
  const order = await prisma.order.findFirst({
    where: { tenantId, couponCode: code },
    select: { id: true, compensationType: true },
  });
  return order ? { valid: true, type: order.compensationType } : { valid: false };
}

module.exports = { generateCompensationCoupon, markCouponSent, validateCoupon };
