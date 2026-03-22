// src/middleware/auth.middleware.js
// Autenticação: sessão Supabase (staff) OU API key (integrações técnicas).
// Painel usa sessão; API key só para integrações quando ALLOW_API_KEY_FALLBACK.

const ENV = require("../config/env");
const prisma = require("../lib/db");
const authService = require("../services/auth.service");

/** Extrai Bearer token do header (nunca de query string para humano) */
function getBearerToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return null;
  return auth.slice(7).trim();
}

/** Carrega staff user na req (após validação) */
function attachStaffToReq(req, staff) {
  if (!staff) return;
  req.user = { id: staff.authUserId, email: staff.email };
  req.staffUser = staff;
  req.tenantScope = staff.tenantId;
  req.tenantId = staff.tenantId;
  req.role = staff.role;
  req.attendant = { name: staff.name, key: staff.id, role: staff.role };
}

/** Autenticação por sessão Supabase (Bearer token) — usa auth.service */
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

/** Fallback: auth direta quando auth.service não configurado (Supabase ausente) */
async function authBySessionFallback(req) {
  if (authService.isAuthConfigured()) return false;
  const supabaseAuth = require("../services/supabase-auth.service");
  const token = getBearerToken(req);
  if (!token) return false;
  const user = await supabaseAuth.verifyToken(token);
  if (!user) return false;
  const staff = await prisma.staffUser.findFirst({
    where: { authUserId: user.id, active: true },
    include: { tenant: true },
  });
  if (!staff) return false;
  attachStaffToReq(req, staff);
  return true;
}

/** Autenticação por API key (fallback para integrações) */
async function authByApiKey(req) {
  const key =
    req.headers["x-api-key"] ||
    req.headers["x-attendant-key"] ||
    req.headers.authorization?.replace(/^Bearer\s+/i, "").trim() ||
    req.query.key;
  const tenantId = req.headers["x-tenant-id"] || req.query.tenant;

  if (ENV.ADMIN_API_KEY && key === ENV.ADMIN_API_KEY) {
    req.role = "admin";
    req.tenantId = tenantId || null;
    req.staffUser = { role: "admin", tenantId: req.tenantId, name: "API Admin" };
    req.tenantScope = req.tenantId;
    req.attendant = { name: "API Admin", role: "admin" };
    return true;
  }
  if (ENV.ATTENDANT_API_KEY && key === ENV.ATTENDANT_API_KEY) {
    req.tenantId = tenantId || null;
    req.role = "attendant";
    req.staffUser = { role: "attendant", tenantId: req.tenantId, name: "API Attendant" };
    req.tenantScope = req.tenantId;
    req.attendant = { name: "API Attendant", role: "attendant" };
    return true;
  }
  if (tenantId && key) {
    const cfg = await prisma.config.findUnique({ where: { key: `${tenantId}:attendants` } });
    if (cfg) {
      const attendants = JSON.parse(cfg.value);
      const att = attendants.find((a) => a.key === key);
      if (att) {
        req.tenantId = tenantId;
        req.role = att.role || "attendant";
        req.staffUser = { role: req.role, tenantId, name: att.name };
        req.tenantScope = tenantId;
        req.attendant = att;
        return true;
      }
    }
  }
  return false;
}

/** Painel: exige sessão Supabase. Fallback API key só se ALLOW_API_KEY_FALLBACK. */
async function requireStaffAuth(req, res, next) {
  if (await authBySession(req)) return next();
  if (await authBySessionFallback(req)) return next();
  if (ENV.ALLOW_API_KEY_FALLBACK && (await authByApiKey(req))) return next();
  const denied = req._authDenied;
  return res.status(401).json({
    error: denied?.reason || "unauthorized",
    code: denied?.reason || "SESSION_REQUIRED",
    message: denied?.message || "Sessão inválida ou expirada. Faça login novamente.",
  });
}

/** Dash: acesso a atendimento (attendant, manager, admin) */
async function authDash(req, res, next) {
  return requireStaffAuth(req, res, next);
}

/** Admin: apenas role admin */
async function authAdmin(req, res, next) {
  if (await authBySession(req) || await authBySessionFallback(req)) {
    if (req.role === "admin") return next();
    return res.status(403).json({ error: "forbidden", message: "Acesso restrito a administradores." });
  }
  if (ENV.ALLOW_API_KEY_FALLBACK && (await authByApiKey(req))) {
    if (req.role === "admin") return next();
    return res.status(403).json({ error: "forbidden" });
  }
  return res.status(401).json({
    error: "unauthorized",
    code: "SESSION_REQUIRED",
    message: "Sessão inválida ou expirada. Faça login novamente.",
  });
}

/** API key pura (integrações técnicas) - sem staff */
async function requireAdminKey(req, res, next) {
  const raw = req.headers["x-api-key"] || req.headers.authorization?.replace(/^Bearer\s+/i, "").trim();
  if (ENV.ADMIN_API_KEY && raw === ENV.ADMIN_API_KEY) return next();
  return res.status(401).json({ error: "unauthorized" });
}

/** API key attendant (integrações) */
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
