// src/routes/admin.routes.js
// MELHORIA: rota POST /admin/cw-retry para reprocessar pedidos CW manualmente

const express = require("express");
const prisma = require("../lib/db");
const orderPixDbCompat = require("../lib/order-pix-db-compat");
const { requireAdminKey } = require("../middleware/auth.middleware");
const { invalidateCache, listActive } = require("../services/tenant.service");

const router = express.Router();
router.use(requireAdminKey);

// GET /admin/whatsapp-cloud/diagnostic — telemetria do último webhook Cloud + IDs cadastrados (x-api-key admin)
router.get("/whatsapp-cloud/diagnostic", async (_req, res) => {
  try {
    const metaTelemetry = require("../lib/meta-telemetry");
    const tenants = await prisma.tenant.findMany({
      select: { id: true, name: true, waPhoneNumberId: true, active: true },
      orderBy: { name: "asc" },
    });
    res.json({
      lastWebhook: metaTelemetry.getWhatsAppCloudTelemetry(),
      tenants: tenants.map((t) => ({
        id: t.id,
        name: t.name,
        active: t.active,
        waPhoneNumberId: t.waPhoneNumberId,
      })),
      note:
        "Compare lastWebhook.lastPhoneNumberIdReceived com tenants[].waPhoneNumberId (ativos). Phone number ID vem do Meta em API do WhatsApp > número de telefone.",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/tenants
router.get("/tenants", async (_req, res) => {
  const tenants = await listActive();
  res.json(tenants.map(sanitize));
});

// POST /admin/tenants
router.post("/tenants", async (req, res) => {
  try {
    const { name, waToken, waPhoneNumberId, waWabaId, cwApiKey, cwPartnerKey, cwStoreId, cwBaseUrl, city } = req.body;
    if (!name || !waToken || !waPhoneNumberId || !cwApiKey || !cwPartnerKey) {
      return res
        .status(400)
        .json({ error: "Campos obrigatórios: name, waToken, waPhoneNumberId, cwApiKey, cwPartnerKey" });
    }
    const tenant = await prisma.tenant.create({
      data: {
        name,
        waToken,
        waPhoneNumberId,
        waWabaId: waWabaId || null,
        cwApiKey,
        cwPartnerKey,
        cwStoreId: cwStoreId || null,
        cwBaseUrl: cwBaseUrl || "https://integracao.cardapioweb.com",
        city: city || null,
        active: true,
      },
    });
    res.status(201).json(sanitize(tenant));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /admin/tenants/:id
router.patch("/tenants/:id", async (req, res) => {
  try {
    const tenant = await prisma.tenant.update({
      where: { id: req.params.id },
      data: req.body,
    });
    invalidateCache(req.params.id);
    res.json(sanitize(tenant));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/tenants/:id  (desativa, não exclui)
router.delete("/tenants/:id", async (req, res) => {
  try {
    await prisma.tenant.update({ where: { id: req.params.id }, data: { active: false } });
    invalidateCache(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/avise-abertura — dispara "Estamos Abertos!" para quem clicou em "Me avise"
// Chamar às 18h (cron) ou manualmente. Limpa a lista após enviar.
router.post("/avise-abertura", async (req, res) => {
  try {
    const tenantId = req.query.tenant || req.body.tenantId;
    const aviseAbertura = require("../services/avise-abertura.service");
    const results = await aviseAbertura.notificarClientesAbertura(tenantId);
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/avise-abertura — lista quantos estão na fila (sem enviar)
router.get("/avise-abertura", async (req, res) => {
  try {
    const tenantId = req.query.tenant;
    const aviseAbertura = require("../services/avise-abertura.service");
    const { listActive } = require("../services/tenant.service");
    const tenants = tenantId ? [{ id: tenantId }] : await listActive();
    const counts = await Promise.all(
      tenants.map(async (t) => ({ tenantId: t.id, count: (await aviseAbertura.getAberturaList(t.id)).length })),
    );
    res.json(counts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/cw-retry — força reprocessamento da fila de pedidos com falha no CW
router.post("/cw-retry", async (req, res) => {
  try {
    const cwRetry = require("../services/cw-retry.service");
    // Dispara em background para não travar o request
    cwRetry.runNow().catch((err) => console.error("[Admin] cw-retry manual:", err.message));
    res.json({ ok: true, message: "Reprocessamento iniciado em background" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/cw-failed — lista pedidos que falharam definitivamente no CW
router.get("/cw-failed", async (req, res) => {
  try {
    const tenantId = req.query.tenant;
    const where = { status: "cw_failed" };
    if (tenantId) where.tenantId = tenantId;

    const orders = await prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        ...orderPixDbCompat.getOrderScalarSelect(),
        customer: { select: { name: true, phone: true } },
      },
    });

    res.json(
      orders.map((o) => ({
        id: o.id,
        orderRef: o.id.slice(-6).toUpperCase(),
        tenantId: o.tenantId,
        customerName: o.customer?.name,
        customerPhone: o.customer?.phone,
        total: o.total,
        fulfillment: o.fulfillment,
        paymentMethodName: o.paymentMethodName,
        createdAt: o.createdAt,
      })),
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/rate-limits — visualiza estado atual do rate limiter
router.get("/rate-limits", (_req, res) => {
  const { LIMITS } = require("../lib/rate-limiter");
  res.json({ limits: LIMITS, note: "Estado em memória não disponível via API" });
});

function sanitize(t) {
  const { waToken, cwApiKey, cwPartnerKey, ...safe } = t;
  return safe;
}

module.exports = router;
