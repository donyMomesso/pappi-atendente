// src/routes/orders.routes.js

const express = require("express");
const { requireAttendantKey } = require("../middleware/auth.middleware");
const { requireTenant } = require("../middleware/tenant.middleware");
const { updateStatus, updateCwStatus, findOrderByCwOrderIdGlobal } = require("../services/order.service");
const { setHandoff, findByPhone, waCloudDestination } = require("../services/customer.service");
const { getClients } = require("../services/tenant.service");
const PhoneNormalizer = require("../normalizers/PhoneNormalizer");

const router = express.Router();

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
    const msg = STATUS_MESSAGES[statusKey] || STATUS_MESSAGES[status];
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
              const survey =
                "🌟 Como foi sua experiência? Responda com uma nota de *1 a 5*:\n\n1 = Ruim  |  5 = Excelente\n\nSua opinião nos ajuda a melhorar! 😊";
              await wa.sendText(dest, survey).catch(() => {});
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
    const order = await updateStatus(req.params.id, status, "human", note);
    res.json({ ok: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
