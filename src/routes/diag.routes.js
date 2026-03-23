// src/routes/diag.routes.js

const express = require("express");
const { requireAdminKey } = require("../middleware/auth.middleware");
const { getClients, listActive } = require("../services/tenant.service");
const prisma = require("../lib/db");
const baileys = require("../services/baileys.service");

const router = express.Router();
const ENV = require("../config/env");

// Debug: verifica se ADMIN_API_KEY está configurada (sem revelar o valor)
router.get("/diag/auth-check", (_req, res) => {
  res.json({
    adminKeyConfigured: !!(ENV.ADMIN_API_KEY && ENV.ADMIN_API_KEY.length > 0),
    hint: ENV.ADMIN_API_KEY
      ? "Chave existe. Use: ?key=SUA_CHAVE ou header x-api-key"
      : "ADMIN_API_KEY não configurada no Render/env",
  });
});

// Teste de conectividade do Cardápio Web (usado pelo bot para catalog, pedidos, etc.)
router.get("/diag/cw", requireAdminKey, async (req, res) => {
  try {
    const tenants = await listActive();
    if (!tenants.length) {
      return res.json({ ok: false, error: "Nenhum tenant ativo" });
    }
    const tenantId = req.query.tenant || tenants[0].id;
    const { cw, config } = await getClients(tenantId);

    const result = { tenantId, tenantName: config.name, cw: {} };

    const [catalog, merchant, paymentMethods] = await Promise.all([
      cw.getCatalog().catch((e) => ({ error: e.message })),
      cw.getMerchant().catch((e) => ({ error: e.message })),
      cw.getPaymentMethods().catch((e) => ({ error: e.message })),
    ]);

    result.cw.catalog = catalog?.error
      ? { ok: false, error: catalog.error }
      : {
          ok: true,
          categories: catalog?.categories?.length ?? catalog?.data?.categories?.length ?? 0,
          hasData: !!catalog && (!!catalog.categories?.length || !!catalog.data?.categories?.length),
        };
    result.cw.merchant = merchant?.error ? { ok: false, error: merchant.error } : { ok: true };
    result.cw.paymentMethods = paymentMethods?.error
      ? { ok: false, error: paymentMethods.error }
      : { ok: true, count: Array.isArray(paymentMethods) ? paymentMethods.length : 0 };

    result.ok =
      result.cw.catalog.ok && result.cw.merchant.ok && (result.cw.paymentMethods.ok || !paymentMethods?.length);

    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Teste de conectividade das IAs (Gemini + OpenAI fallback)
router.get("/diag/ai", requireAdminKey, async (_req, res) => {
  try {
    const gemini = require("../services/gemini.service");
    const status = await gemini.testAI();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
