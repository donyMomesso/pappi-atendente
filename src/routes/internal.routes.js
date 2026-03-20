// src/routes/internal.routes.js

const express = require("express");
const { requireAttendantKey } = require("../middleware/auth.middleware");
const { getClients }          = require("../services/tenant.service");
const PhoneNormalizer         = require("../normalizers/PhoneNormalizer");

const router = express.Router();
router.use(requireAttendantKey);

router.post("/send", async (req, res) => {
  try {
    const { phone, text } = req.body;
    const tenantId = req.query.tenant || req.body.tenantId;
    if (!phone || !text)  return res.status(400).json({ error: "phone e text obrigatórios" });
    if (!tenantId)        return res.status(400).json({ error: "tenantId obrigatório" });

    const normalized = PhoneNormalizer.normalize(phone);
    if (!normalized) return res.status(400).json({ error: "Telefone inválido" });

    const { wa }      = await getClients(tenantId);
    const result      = await wa.sendText(normalized, text);
    const waMessageId = result?.messages?.[0]?.id;

    const { findByPhone } = require("../services/customer.service");
    const chatMemory      = require("../services/chat-memory.service");
    const customer        = await findByPhone(tenantId, normalized);
    if (customer) {
      await chatMemory.push(customer.id, "attendant", text, req.attendant?.name || "Atendente", null, "text", waMessageId);
    }

    res.json({ ok: true, to: normalized });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
