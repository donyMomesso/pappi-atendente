// src/middleware/tenant.middleware.js
// Req 6 — Injetar tenant no req a partir do header X-Tenant-ID

const { getTenantById } = require("../services/tenant.service");

/**
 * Middleware que lê X-Tenant-ID do header e popula req.tenant.
 * Usado nas rotas internas e de admin.
 */
async function requireTenant(req, res, next) {
  const tenantId = req.headers["x-tenant-id"];
  if (!tenantId) {
    return res.status(400).json({ error: "Header X-Tenant-ID obrigatório" });
  }

  const tenant = await getTenantById(tenantId).catch(() => null);
  if (!tenant || !tenant.active) {
    return res.status(404).json({ error: "Tenant não encontrado ou inativo" });
  }

  req.tenant = tenant;
  next();
}

module.exports = { requireTenant };
