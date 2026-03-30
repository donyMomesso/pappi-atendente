// src/middleware/auth.middleware.js
// Autenticação por API key em header. Sessão Supabase opcional.

const prisma = require("../lib/db");
const ENV = require("../config/env");
const authService = require("../services/auth.service");
const attendantsConfig = require("../lib/attendants-config");

/** Retorna true se a requisição traz API key explícita em header. */
function hasExplicitApiKey(req) {
  return !!(req.headers["x-api-key"] || req.headers["x-attendant-key"] || getBearerToken(req));
}

function getBearerToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return null;
  return auth.slice(7).trim();
}

function attachStaffToReq(req, staff) {
  if (!staff) return;
  req.user = { id: staff.authUserId, email: staff.email };
  req.staffUser = staff;
  req.tenantScope = staff.tenantId;
  req.tenantId = staff.tenantId;
  req.role = staff.role;
  req.attendant = { name: staff.name, key: staff.id, role: staff.role, email: staff.email || null };
}

async function authBySession(req) {
  const token = getBearerToken(req);
  if (!token) return false;
  const result = await authService.verifySession(token, {
    ip: req.ip,
    userAgent: req.headers["user-agent"],
  });
  if (result?.denied) {
    req._authDenied = { reason: result.reason, message: result.message };
    return false;
  }
  if (!result?.staffUser) return false;
  attachStaffToReq(req, result.staffUser);
  return true;
}

async function authBySessionFallback(req) {
  if (authService.isAuthConfigured()) return false;
  const supabaseAuth = require("../services/supabase-auth.service");
  const token = getBearerToken(req);
  if (!token) return false;
  const user = await supabaseAuth.verifyToken(token);
  if (!user) return false;
  const staff = await prisma.staff_users.findFirst({
    where: { authUserId: user.id, active: true },
    include: { tenant: true },
  });
  if (!staff) return false;
  attachStaffToReq(req, staff);
  return true;
}

async function authByApiKey(req) {
  const key =
    req.headers["x-api-key"] ||
    req.headers["x-attendant-key"] ||
    req.headers.authorization?.replace(/^Bearer\s+/i, "").trim();
  const tenantId = req.headers["x-tenant-id"] || null;

  if (ENV.ADMIN_API_KEY && key === ENV.ADMIN_API_KEY) {
    req.role = "admin";
    req.tenantId = tenantId || null;
    req.staffUser = { role: "admin", tenantId: req.tenantId, name: "API Admin" };
    req.tenantScope = req.tenantId;
    req.attendant = { name: "API Admin", role: "admin", email: null };
    req.user = { role: "admin", name: "Admin" };
    return true;
  }
  if (ENV.ATTENDANT_API_KEY && key === ENV.ATTENDANT_API_KEY) {
    req.role = "attendant";
    req.tenantId = tenantId || null;
    req.staffUser = { role: "attendant", tenantId: req.tenantId, name: "API Atendente" };
    req.tenantScope = req.tenantId;
    req.attendant = { name: "API Atendente", role: "attendant", email: null };
    req.user = { role: "attendant", name: "Atendente" };
    return true;
  }
  if (!tenantId) return false;
  const tid = tenantId;
  const cfg = await prisma.config.findUnique({ where: { key: `${tid}:attendants` } });
  if (cfg) {
    const attendants = attendantsConfig.normalizeAttendantsList(attendantsConfig.parseAttendantsJson(cfg.value));
    const att = attendants.find((a) => a.key === key);
    if (att) {
      req.tenantId = tid;
      req.role = att.role || "attendant";
      req.staffUser = { role: req.role, tenantId: tid, name: att.name, email: att.email || null };
      req.tenantScope = tid;
      req.attendant = { ...att, email: att.email || null };
      req.user = { role: req.role, name: att.name, email: att.email || null };
      return true;
    }
  }
  return false;
}

async function requireStaffAuth(req, res, next) {
  if (hasExplicitApiKey(req)) {
    if (await authByApiKey(req)) return next();
  }
  if (await authBySession(req)) return next();
  if (await authBySessionFallback(req)) return next();
  if (await authByApiKey(req)) return next();
  const denied = req._authDenied;
  return res.status(401).json({
    error: denied?.reason || "unauthorized",
    code: denied?.reason || "SESSION_REQUIRED",
    message: denied?.message || "Sessão inválida ou expirada. Faça login novamente.",
  });
}

async function authDash(req, res, next) {
  return requireStaffAuth(req, res, next);
}

async function authAdmin(req, res, next) {
  if (hasExplicitApiKey(req)) {
    if (await authByApiKey(req)) {
      if (req.role === "admin") return next();
      return res.status(403).json({ error: "forbidden" });
    }
  }
  if ((await authBySession(req)) || (await authBySessionFallback(req))) {
    if (req.role === "admin") return next();
    return res.status(403).json({ error: "forbidden", message: "Acesso restrito a administradores." });
  }
  if (await authByApiKey(req)) {
    if (req.role === "admin") return next();
    return res.status(403).json({ error: "forbidden" });
  }
  return res.status(401).json({
    error: "unauthorized",
    code: "SESSION_REQUIRED",
    message: "Sessão inválida ou expirada. Faça login novamente.",
  });
}

async function requireAdminKey(req, res, next) {
  const raw = req.headers["x-api-key"] || req.headers.authorization?.replace(/^Bearer\s+/i, "").trim();
  if (ENV.ADMIN_API_KEY && raw === ENV.ADMIN_API_KEY) return next();
  return res.status(401).json({ error: "unauthorized" });
}

async function requireAttendantKey(req, res, next) {
  return authByApiKey(req) ? next() : res.status(401).json({ error: "unauthorized" });
}

const authz = require("./authorization.middleware");

module.exports = {
  requireStaffAuth,
  authDash,
  authAdmin,
  requireRole: authz.requireRole,
  requireTenantAccess: authz.requireTenantAccess,
  requirePermission: authz.requirePermission,
  requireAdminKey,
  requireAttendantKey,
  getBearerToken,
  attachStaffToReq,
};
