// src/services/auth.service.js
// Autenticação privada: Supabase Auth + StaffUser.
// Sem signup público; usuário só entra se existir em StaffUser e estiver ativo.

const supabaseAuth = require("./supabase-auth.service");
const staffUserService = require("./staff-user.service");
const auditLog = require("./audit-log.service");
const log = require("../lib/logger").child({ service: "auth" });

/**
 * Verifica token Supabase, valida StaffUser e atualiza lastLoginAt.
 * Retorna staffUser se autorizado; null se token inválido ou usuário não autorizado.
 *
 * @param {string} accessToken - JWT do Supabase
 * @param {Object} ctx - { ip, userAgent } para auditoria
 * @returns {{ staffUser } | null}
 */
async function verifySessionAndAuthorize(accessToken, ctx = {}) {
  if (!accessToken) return null;

  const authUser = await supabaseAuth.verifyToken(accessToken);
  if (!authUser) {
    return null;
  }

  const staff = await staffUserService.findByAuthUserId(authUser.id);
  if (!staff) {
    await auditLog.logAction({
      action: "login_denied",
      resourceType: "staff_user",
      metadata: { email: authUser.email, reason: "user_not_authorized" },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return null;
  }

  if (!staff.active) {
    await auditLog.logAction({
      action: "login_denied",
      resourceType: "staff_user",
      resourceId: staff.id,
      metadata: { email: staff.email, reason: "user_inactive" },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return null;
  }

  return { staffUser: staff };
}

/**
 * Solicita reset de senha por email.
 * Só permite se o usuário existir em StaffUser e estiver ativo.
 *
 * @param {string} email
 * @param {Object} ctx - { ip, userAgent }
 * @throws {Error} se email não autorizado
 */
async function requestPasswordReset(email, ctx = {}) {
  const emailNorm = String(email).trim().toLowerCase();
  const staff = await staffUserService.findByEmail(emailNorm);

  if (!staff || !staff.active) {
    await auditLog.logAction({
      action: "reset_password_denied",
      metadata: { email: emailNorm, reason: staff ? "user_inactive" : "user_not_found" },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    throw new Error("E-mail não encontrado ou não autorizado. Entre em contato com o administrador.");
  }

  await supabaseAuth.resetPasswordForEmail(emailNorm);

  await auditLog.logAction({
    action: "reset_password_requested",
    resourceType: "staff_user",
    resourceId: staff.id,
    userId: staff.id,
    metadata: { email: emailNorm },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}

/**
 * Verifica se o sistema de auth está configurado.
 */
function isAuthConfigured() {
  return supabaseAuth.isConfigured();
}

module.exports = {
  verifySessionAndAuthorize,
  requestPasswordReset,
  isAuthConfigured,
};
