// src/routes/pix.routes.js
// Webhook PIX (Inter) para confirmar pagamento e só então enviar pedido ao Cardápio Web.

const express = require("express");
const prisma = require("../lib/db");
const orderPixDbCompat = require("../lib/order-pix-db-compat");
const log = require("../lib/logger").child({ service: "pix-webhook" });

const router = express.Router();
let warnedMissingToken = false;

function normalizeTxid(v) {
  return String(v || "").trim();
}

router.post("/pix/webhook", async (req, res) => {
  // Sempre responde 200 rápido para evitar retries agressivos
  res.sendStatus(200);

  try {
    const token = (process.env.INTER_WEBHOOK_TOKEN || "").trim();
    if (token) {
      const got = String(req.headers["x-webhook-token"] || req.query.token || "").trim();
      if (got !== token) {
        log.warn({ hasToken: !!got }, "PIX webhook: token inválido (ignorado)");
        return;
      }
    } else if (process.env.NODE_ENV === "production" && !warnedMissingToken) {
      warnedMissingToken = true;
      log.warn(
        "PIX webhook: INTER_WEBHOOK_TOKEN não configurado — webhook está sem autenticação. Configure para fail-closed.",
      );
    }

    const body = req.body || {};
    const pixEvents = Array.isArray(body.pix) ? body.pix : Array.isArray(body?.evento?.pix) ? body.evento.pix : [];
    if (!pixEvents.length) {
      log.warn({ keys: Object.keys(body || {}) }, "PIX webhook: payload sem array pix");
      return;
    }

    if (!orderPixDbCompat.hasOrderPixColumns()) {
      log.error(
        "PIX webhook ignorado: colunas orders.pixTxid/pixE2eId/pixStatus ausentes no banco. Aplique a migration PIX (prisma migrate deploy).",
      );
      return;
    }

    const { getClients } = require("../services/tenant.service");
    const { setCwOrderId, updateStatus } = require("../services/order.service");
    const baileys = require("../services/baileys.service");

    for (const ev of pixEvents) {
      const txid = normalizeTxid(ev?.txid || ev?.txId || ev?.cob?.txid);
      const e2eId = normalizeTxid(ev?.endToEndId || ev?.e2eId || ev?.endtoendid);
      if (!txid) continue;

      // IDEMPOTÊNCIA (robusta):
      // - Se o webhook chegar repetido, só 1 worker deve "claimar" o envio ao CW.
      // - Usamos pixStatus='processing' como trava leve e cwOrderId como trava definitiva.
      const already = await prisma.order.findFirst({ where: { pixTxid: txid }, select: { id: true, cwOrderId: true } });
      if (!already) {
        log.warn({ txid }, "PIX webhook: pedido não encontrado para txid");
        continue;
      }
      if (already.cwOrderId) {
        await prisma.order.update({
          where: { id: already.id },
          data: { pixStatus: "paid", pixE2eId: e2eId || null },
          select: { id: true },
        });
        continue;
      }

      const claim = await prisma.order.updateMany({
        where: {
          id: already.id,
          cwOrderId: null,
          pixStatus: { notIn: ["processing", "paid"] },
        },
        data: { pixStatus: "processing", pixE2eId: e2eId || null },
      });
      if (!claim.count) {
        // Outro processo já está enviando ou já marcou como pago/processando
        log.info({ txid, orderId: already.id }, "PIX webhook: evento duplicado — já em processamento");
        continue;
      }

      const order = await prisma.order.findFirst({
        where: { id: already.id },
        include: { tenant: true, customer: true },
      });
      if (!order) continue;
      if (!order.cwPayload) {
        log.warn({ orderId: order.id, txid }, "PIX webhook: pedido sem cwPayload (não pode enviar ao CW)");
        await prisma.order.update({
          where: { id: order.id },
          data: { pixStatus: "paid", status: "cw_failed" },
          select: { id: true },
        });
        continue;
      }

      const cwPayload = JSON.parse(order.cwPayload);
      const { cw } = await getClients(order.tenantId);

      try {
        const cwResponse = await cw.createOrder(cwPayload);
        const cwOrderId = cwResponse?.id || cwResponse?.order_id;
        if (cwOrderId) await setCwOrderId(order.id, cwOrderId, cwResponse);

        await prisma.order.update({
          where: { id: order.id },
          data: { pixStatus: "paid", pixE2eId: e2eId || null },
          select: { id: true },
        });
        await updateStatus(order.id, "waiting_confirmation", "pix_webhook", "PIX confirmado — pedido enviado ao CW");

        const ref = order.id.slice(-6).toUpperCase();
        await baileys.notify(`💸✅ *PIX confirmado* — Pedido #${ref} enviado ao Cardápio Web.`).catch(() => {});
        log.info({ orderId: order.id, txid, cwOrderId }, "PIX webhook: pedido enviado ao CW");
      } catch (err) {
        log.error({ orderId: order.id, txid, err: err.message }, "PIX webhook: falha ao enviar ao CW");
        // PIX já foi pago — não podemos perder o pedido.
        // Marca status intermediário para permitir retry (cw-retry não roda em pix_pending).
        await prisma.order
          .update({
            where: { id: order.id },
            data: { pixStatus: "paid", status: "pix_paid", pixE2eId: e2eId || null },
            select: { id: true },
          })
          .catch(() => {});
        await prisma.orderStatusLog
          .create({
            data: {
              orderId: order.id,
              status: "cw_retry_failed",
              source: "pix_webhook",
              note: `Falha ao enviar ao CW após PIX confirmado: ${err.message}`,
            },
          })
          .catch(() => {});
      }
    }
  } catch (err) {
    log.error({ err }, "PIX webhook: erro geral");
  }
});

module.exports = router;

