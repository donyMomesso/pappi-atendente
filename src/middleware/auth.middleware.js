// src/middleware/auth.middleware.js

const ENV = require("../config/env");

/**
 * Valida chave de API interna (painel de atendimento).
 */
function requireAttendantKey(req, res, next) {
  const key = req.headers["x-api-key"] || req.headers["authorization"]?.replace("Bearer ", "");
  if (!ENV.ATTENDANT_API_KEY || key !== ENV.ATTENDANT_API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
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

module.exports = { requireAttendantKey, requireAdminKey };
