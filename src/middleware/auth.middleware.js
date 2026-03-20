// src/middleware/auth.middleware.js
// CORREÇÃO: usa singleton do PrismaClient

const ENV = require("../config/env");
const prisma = require("../lib/db");

async function requireAttendantKey(req, res, next) {
  const key =
    req.headers["x-api-key"] ||
    req.headers["authorization"]?.replace("Bearer ", "") ||
    req.headers["x-attendant-key"] ||
    req.query.key;
  const tenantId = req.headers["x-tenant-id"] || req.query.tenant;

  if (ENV.ATTENDANT_API_KEY && key === ENV.ATTENDANT_API_KEY) return next();

  if (tenantId && key) {
    const attendantsConfig = await prisma.config.findUnique({
      where: { key: `${tenantId}:attendants` },
    });
    if (attendantsConfig) {
      const attendants = JSON.parse(attendantsConfig.value);
      const attendant = attendants.find((att) => att.key === key);
      if (attendant) {
        req.attendant = attendant;
        return next();
      }
    }
  }

  return res.status(401).json({ error: "unauthorized" });
}

function requireAdminKey(req, res, next) {
  const key = req.headers["x-api-key"] || req.headers["authorization"]?.replace("Bearer ", "");
  if (!ENV.ADMIN_API_KEY || key !== ENV.ADMIN_API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

async function authDash(req, res, next) {
  return requireAttendantKey(req, res, next);
}

async function authAdmin(req, res, next) {
  return requireAdminKey(req, res, next);
}

module.exports = { requireAttendantKey, requireAdminKey, authDash, authAdmin };
