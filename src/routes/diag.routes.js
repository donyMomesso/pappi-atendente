// src/routes/diag.routes.js

const express = require("express");
const { requireAdminKey } = require("../middleware/auth.middleware");
const { getClients, listActive } = require("../services/tenant.service");
const prisma = require("../lib/db");
const baileys = require("../services/baileys.service");

const router = express.Router();

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

// Diagnóstico de roteamento de mensagens
router.get("/diag/routing/check", requireAdminKey, async (_req, res) => {
  try {
    const tenants = await listActive();
    const baileysStatus = await baileys.getAllStatuses();
    const customerCount = await prisma.customer.count();
    const recentMessages = await prisma.message.count({
      where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    });

    const issues = [];

    if (tenants.length === 0) {
      issues.push("Nenhum tenant ativo — mensagens de todos os canais serão descartadas");
    }

    for (const t of tenants) {
      if (!t.waToken || t.waToken === "dev-token-placeholder") {
        issues.push(`Tenant "${t.name}" tem waToken inválido — Cloud API não funcionará`);
      }
    }

    const connectedBaileys = baileysStatus.filter((s) => s.status === "connected");
    if (connectedBaileys.length === 0 && baileysStatus.length > 0) {
      issues.push("Nenhuma instância Baileys conectada — mensagens QR não serão recebidas");
    }

    res.json({
      tenants: tenants.map((t) => ({ id: t.id, name: t.name, waPhoneNumberId: t.waPhoneNumberId })),
      baileys: baileysStatus,
      stats: { customerCount, recentMessages24h: recentMessages },
      issues: issues.length > 0 ? issues : ["Nenhum problema detectado"],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
