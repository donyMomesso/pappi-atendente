// src/routes/orders.routes.js
// Rotas para painel de atendimento (handoff, status)

const express = require("express");
const { requireAttendantKey } = require("../middleware/auth.middleware");
const { requireTenant } = require("../middleware/tenant.middleware");
const { updateStatus, findByCwOrderId } = require("../services/order.service");
const { setHandoff, findByPhone } = require("../services/customer.service");
const { getClients } = require("../services/tenant.service");
const PhoneNormalizer = require("../normalizers/PhoneNormalizer");

const router = express.Router();
router.use(requireAttendantKey, requireTenant);

// PUT /orders/handoff  — ativar/desativar handoff para um cliente
router.put("/handoff", async (req, res) => {
  try {
    const { phone, enabled } = req.body;
    if (!phone) return res.status(400).json({ error: "phone obrigatório" });

    const normalized = PhoneNormalizer.normalize(phone);
    const customer = await findByPhone(req.tenant.id, normalized);
    if (!customer) return res.status(404).json({ error: "Cliente não encontrado" });

    await setHandoff(customer.id, !!enabled);

    // Se devolvendo para o bot, envia mensagem de retomada
    if (!enabled) {
      const { wa } = await getClients(req.tenant.id);
      await wa.sendText(
        normalized,
        "Olá! Estou de volta para te ajudar. 😊 O que deseja?"
      ).catch(() => {});
    }

    res.json({ ok: true, handoff: !!enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /orders/:id/status  — atualizar status de um pedido
router.post("/:id/status", async (req, res) => {
  try {
    const { status, note } = req.body;
    const order = await updateStatus(req.params.id, status, "human", note);
    res.json({ ok: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /orders/cw-status  — webhook do CardápioWeb (mudança de status)
router.post("/cw-status", async (req, res) => {
  try {
    res.sendStatus(200);
    const { order_id, status } = req.body;
    if (!order_id || !status) return;

    const order = await findByCwOrderId(req.tenant.id, String(order_id));
    if (!order) return;

    await updateStatus(order.id, status, "webhook");

    // Notifica o cliente via WA
    const msg = STATUS_MESSAGES[status];
    if (msg && order.customer?.phone) {
      const { wa } = await getClients(req.tenant.id);
      await wa.sendText(order.customer.phone, msg).catch(() => {});
    }
  } catch (err) {
    console.error("cw-status:", err.message);
  }
});

const STATUS_MESSAGES = {
  confirmed:    "✅ Seu pedido foi *confirmado* pela loja!",
  in_production:"👨‍🍳 Seu pedido está *em produção*!",
  dispatched:   "🛵 Seu pedido saiu para *entrega*!",
  delivered:    "🎉 Seu pedido foi *entregue*! Bom apetite!",
  cancelled:    "❌ Seu pedido foi *cancelado*. Entre em contato se tiver dúvidas.",
};

module.exports = router;
