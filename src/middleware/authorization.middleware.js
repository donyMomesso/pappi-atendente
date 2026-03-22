// src/middleware/authorization.middleware.js
// Autorização por role e tenant. Requer req.staffUser preenchido pelo auth.

/**
 * Exige autenticação. req.staffUser deve existir (preenchido por requireStaffAuth).
 */
function requireAuth(req, res, next) {
  if (!req.staffUser) {
    return res.status(401).json({
      error: "unauthorized",
      message: "Autenticação necessária.",
    });
  }
  next();
}

/**
 * Exige uma das roles informadas.
 * @param {...string} roles - admin, manager, attendant
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.staffUser) {
      return res.status(401).json({ error: "unauthorized", message: "Autenticação necessária." });
    }
    if (roles.includes(req.role)) return next();
    return res.status(403).json({
      error: "forbidden",
      message: "Permissão insuficiente.",
    });
  };
}

/**
 * Exige acesso ao tenant da requisição.
 * Admin global passa sempre; manager/attendant só acessam o próprio tenant.
 */
function requireTenantAccess(req, res, next) {
  if (!req.staffUser) {
    return res.status(401).json({ error: "unauthorized", message: "Autenticação necessária." });
  }
  if (req.role === "admin") return next();

  const tenantId = req.query.tenant || req.body?.tenantId || req.params?.tenantId || req.tenantScope;
  if (!tenantId) {
    return res.status(400).json({ error: "tenant_required", message: "Tenant é obrigatório." });
  }
  if (req.tenantScope !== tenantId) {
    return res.status(403).json({
      error: "forbidden",
      message: "Acesso negado a este tenant.",
    });
  }
  next();
}

/**
 * Exige permissão específica (canViewOrders, canSendMessages, etc).
 * @param {...string} permissions - canViewOrders, canSendMessages, canManageCoupons, canManageSettings, canManageUsers
 */
function requirePermission(...permissions) {
  return (req, res, next) => {
    if (!req.staffUser) {
      return res.status(401).json({ error: "unauthorized", message: "Autenticação necessária." });
    }
    const staff = req.staffUser;
    for (const p of permissions) {
      if (staff[p] === true) return next();
    }
    return res.status(403).json({
      error: "forbidden",
      message: "Permissão insuficiente.",
    });
  };
}

module.exports = {
  requireAuth,
  requireRole,
  requireTenantAccess,
  requirePermission,
};
