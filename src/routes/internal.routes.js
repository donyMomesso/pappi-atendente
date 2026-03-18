// src/routes/internal.routes.js
// Envio manual de mensagens pelo painel de atendimento

const express = require("express");
const { requireAttendantKey } = require("../middleware/auth.middleware");
const { requireTenant } = require("../middleware/tenant.middleware");
const { getClients } = require("../services/tenant.service");
const PhoneNormalizer = require("../normalizers/PhoneNormalizer");

const router = express.Router();
router.use(requireAttendantKey, requireTenant);

// POST /internal/send  — enviar mensagem manual para um cliente
router.post("/send", async (req, res) => {
  try {
    const { phone, text } = req.body;
    if (!phone || !text) return res.status(400).json({ error: "phone e text obrigatórios" });

    const normalized = PhoneNormalizer.normalize(phone);
    if (!normalized) return res.status(400).json({ error: "Telefone inválido" });

    const { wa } = await getClients(req.tenant.id);
    await wa.sendText(normalized, text);

    // Salva no histórico de mensagens
    const { findByPhone } = require("../services/customer.service");
    const chatMemory = require("../services/chat-memory.service");
    const customer = await findByPhone(req.tenant.id, normalized);
    if (customer) {
      await chatMemory.push(customer.id, "attendant", text, req.headers["x-attendant-name"] || "Atendente");
    }

    res.json({ ok: true, to: normalized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
