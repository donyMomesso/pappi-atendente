// src/routes/orders.routes.js

const express = require("express");
const { requireAttendantKey } = require("../middleware/auth.middleware");
const { requireTenant } = require("../middleware/tenant.middleware");
const { updateStatus, updateCwStatus, findOrderByCwOrderIdGlobal } = require("../services/order.service");
const { setHandoff, findByPhone, waCloudDestination } = require("../services/customer.service");
const { getClients } = require("../services/tenant.service");
const PhoneNormalizer = require("../normalizers/PhoneNormalizer");
const prisma = require("../lib/db");

const router = express.Router();
const GOOGLE_REVIEW_URL =
  "https://www.google.com/search?sca_esv=9246bc9b7addcc13&sxsrf=ANbL-n7QrLnNDNJNDCBiiND4G0LvcKSanA:1774541776308&si=AL3DRZEsmMGCryMMFSHJ3StBhOdZ2-6yYkXd_doETEE1OR-qOY9HBv12ESnfD4AEouCNN5LHxzhbfjhyzrGiYaWjVTUorbe9U60PWGh0IWYPWdVOv91TJ9QYPdyPe53lg-lC0T1X-I7-LaOt25dlqZaq_-W0RJLMKw%3D%3D&q=Pappi+Pizza+Pizzaria+Coment%C3%A1rios&sa=X&ved=2ahUKEwiD6tyh-72TAxV8jpUCHeOnIgAQ0bkNegQILRAH&biw=1242&bih=575&dpr=1.1";

// Webhook CW (sem auth; tenant inferido pelo order)
router.post("/cw-status", async (req, res) => {
  try {
    res.sendStatus(200);
    const { order_id, status } = req.body;
    if (!order_id || !status) return;

    const order = await findOrderByCwOrderIdGlobal(String(order_id));
    if (!order) return;

    await updateStatus(order.id, status, "webhook");
    await updateCwStatus(order.id, status);

    const statusKey = String(status).toLowerCase().replace(/\s/g, "_");
    const msg = getCustomerStatusMessage(statusKey, order);
    if (msg && order.customer) {
      const { getClients } = require("../services/tenant.service");
      const { wa } = await getClients(order.tenantId);
      let dest;
      try {
        dest = waCloudDestination(order.customer);
      } catch {
        dest = null;
      }
      if (dest) {
        await wa.sendText(dest, msg).catch(() => {});

        if (["delivered", "pedido_concluido"].includes(statusKey)) {
          setTimeout(async () => {
            try {
              if (!shouldSendReviewInvite(order)) return;
              const reviewInvite =
                "🌟 Obrigado por pedir na Pappi!\n\nSe puder, nos avalie no Google:\n" +
                `${GOOGLE_REVIEW_URL}\n\nSua avaliação ajuda muito! 🙏`;
              await wa.sendText(dest, reviewInvite).catch(() => {});
            } catch {}
          }, 30_000);
        }
      }
    }
  } catch (err) {
    console.error("cw-status:", err.message);
  }
});

const STATUS_MESSAGES = {
  confirmed: "✅ Seu pedido foi *confirmado* pela loja!",
  in_production: "👨‍🍳 Seu pedido está *em produção*!",
  em_producao: "👨‍🍳 Seu pedido está *em produção*!",
  dispatched: "🛵 Seu pedido saiu para *entrega*!",
  saiu_para_entrega: "🛵 Seu pedido saiu para *entrega*!",
  pronto_para_retirada: "📦 Seu pedido está *pronto para retirada*!",
  delivered: "🎉 Seu pedido foi *entregue*! Bom apetite!",
  pedido_concluido: "🎉 Seu pedido foi *entregue*! Bom apetite!",
  cancelled: "❌ Seu pedido foi *cancelado*. Entre em contato se tiver dúvidas.",
};

function getCustomerStatusMessage(statusKey, order) {
  const k = normalizeStatusKey(statusKey);
  if (["delivered", "pedido_concluido"].includes(k)) {
    if (String(order?.fulfillment || "").toLowerCase() === "takeout") {
      return "🎉 Seu pedido foi *retirado*! Obrigado e bom apetite 😋";
    }
    return "🎉 Seu pedido foi *entregue*! Bom apetite 😋";
  }
  return STATUS_MESSAGES[k] || STATUS_MESSAGES[statusKey];
}

function shouldSendReviewInvite(order) {
  const fulfillment = String(order?.fulfillment || "").toLowerCase();
  if (fulfillment === "takeout") return true;
  if (fulfillment !== "delivery") return true;
  const hadDelayAlert = Boolean(
    order?.delayAlertSentAt || order?.secondDelayAlertSentAt || order?.thirdDelayAlertSentAt || order?.attendantAlertSentAt,
  );
  return !hadDelayAlert;
}

function normalizeStatusKey(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");
}

function isConcludeLikeStatus(s) {
  const k = normalizeStatusKey(s);
  return ["concluded", "delivered", "pedido_concluido"].includes(k);
}

router.use(requireAttendantKey, requireTenant);

router.put("/handoff", async (req, res) => {
  try {
    const { phone, enabled } = req.body;
    if (!phone) return res.status(400).json({ error: "phone obrigatório" });
    const normalized = PhoneNormalizer.normalize(phone);
    const customer = await findByPhone(req.tenant.id, normalized);
    if (!customer) return res.status(404).json({ error: "Cliente não encontrado" });
    await setHandoff(customer.id, !!enabled);
    if (!enabled) {
      const { wa } = await getClients(req.tenant.id);
      await wa.sendText(normalized, "Olá! Estou de volta para te ajudar. 😊 O que deseja?").catch(() => {});
    }
    res.json({ ok: true, handoff: !!enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/status", async (req, res) => {
  try {
    const { status, note } = req.body;
    const orderDb = await prisma.order.findUnique({
      where: { id: req.params.id },
      select: { id: true, tenantId: true, cwOrderId: true, status: true },
    });
    if (!orderDb || orderDb.tenantId !== req.tenant.id) {
      return res.status(404).json({ error: "Pedido não encontrado" });
    }

    if (orderDb.cwOrderId && isConcludeLikeStatus(status)) {
      const { cw } = await getClients(orderDb.tenantId);
      const cwOrder = await cw.getOrderById(orderDb.cwOrderId).catch(() => null);
      const cwStatus = normalizeStatusKey(cwOrder?.status);
      const cwAlreadyDone = ["concluded", "delivered", "pedido_concluido"].includes(cwStatus);
      if (!cwAlreadyDone) {
        return res.status(409).json({
          ok: false,
          error:
            "Conclusão bloqueada: o CardápioWeb ainda não permite finalizar este pedido. Atualize o status no CW primeiro.",
          cwStatus: cwOrder?.status || null,
          code: "cw_transition_not_allowed",
        });
      }
      await updateCwStatus(orderDb.id, cwOrder.status);
    }

    const order = await updateStatus(req.params.id, status, "human", note);
    res.json({ ok: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
