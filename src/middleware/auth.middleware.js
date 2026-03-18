// src/middleware/auth.middleware.js

const ENV = require("../config/env");

/**
 * Valida chave de API interna (painel de atendimento).
 * Suporta tanto a chave global (ENV) quanto chaves específicas por tenant.
 */
async function requireAttendantKey(req, res, next) {
  const key = req.headers["x-api-key"] || req.headers["authorization"]?.replace("Bearer ", "") || req.headers["x-attendant-key"];
  const tenantId = req.headers["x-tenant-id"] || req.query.tenant;

  // 1. Tenta chave global
  if (ENV.ATTENDANT_API_KEY && key === ENV.ATTENDANT_API_KEY) {
    return next();
  }

  // 2. Tenta chave específica do tenant
  if (tenantId && key) {
    const prisma = require("../lib/prisma");
    const attendantsConfig = await prisma.config.findUnique({
      where: { key: `${tenantId}:attendants` },
    });
    if (attendantsConfig) {
      const attendants = JSON.parse(attendantsConfig.value);
      const attendant = attendants.find(att => att.key === key);
      if (attendant) {
        req.attendant = attendant;
        return next();
      }
    }
  }

  return res.status(401).json({ error: "unauthorized" });
}

/**
 * Valida chave de API de admin.
 */
function requireAdminKey(req, res, next) {
  const key = req.headers["x-api-key"] || req.headers["authorization"]?.replace("Bearer ", "");
  if (!ENV.ADMIN_API_KEY || key !== ENV.ADMIN_API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

/**
 * Middleware para rotas do dashboard que não exigem Admin, mas sim Attendant.
 */
async function authDash(req, res, next) {
  return requireAttendantKey(req, res, next);
}

/**
 * Middleware para rotas de Admin.
 */
async function authAdmin(req, res, next) {
  return requireAdminKey(req, res, next);
}

module.exports = { requireAttendantKey, requireAdminKey, authDash, authAdmin };
