// src/routes/admin.routes.js
// Gerenciamento de tenants (multi-tenant)

const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { requireAdminKey } = require("../middleware/auth.middleware");
const { invalidateCache, listActive } = require("../services/tenant.service");

const prisma = new PrismaClient();
const router = express.Router();
router.use(requireAdminKey);

// GET /admin/tenants
router.get("/tenants", async (_req, res) => {
  const tenants = await listActive();
  res.json(tenants.map(sanitize));
});

// POST /admin/tenants
router.post("/tenants", async (req, res) => {
  try {
    const {
      name, waToken, waPhoneNumberId, waWabaId,
      cwApiKey, cwPartnerKey, cwStoreId, cwBaseUrl,
      city,
    } = req.body;

    if (!name || !waToken || !waPhoneNumberId || !cwApiKey || !cwPartnerKey) {
      return res.status(400).json({ error: "Campos obrigatórios: name, waToken, waPhoneNumberId, cwApiKey, cwPartnerKey" });
    }

    const tenant = await prisma.tenant.create({
      data: {
        name, waToken, waPhoneNumberId,
        waWabaId: waWabaId || null,
        cwApiKey, cwPartnerKey,
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
    await prisma.tenant.update({
      where: { id: req.params.id },
      data: { active: false },
    });
    invalidateCache(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function sanitize(t) {
  // Nunca expõe tokens
  const { waToken, cwApiKey, cwPartnerKey, ...safe } = t;
  return safe;
}

module.exports = router;
