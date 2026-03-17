// src/routes/diag.routes.js
const express = require("express");
const { requireAdminKey } = require("../middleware/auth.middleware");
const { listActive, getClients } = require("../services/tenant.service");

const router = express.Router();

// GET /diag/:tenantId  — testa conexão CW de um tenant
router.get("/diag/:tenantId", requireAdminKey, async (req, res) => {
  try {
    const { cw, config } = await getClients(req.params.tenantId);
    const [merchant, paymentMethods] = await Promise.all([
      cw.getMerchant().catch((e) => ({ error: e.message })),
      cw.getPaymentMethods().catch(() => []),
    ]);
    const open = await cw.isOpen().catch(() => null);
    res.json({ tenant: config.name, open, merchant, paymentMethods });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
