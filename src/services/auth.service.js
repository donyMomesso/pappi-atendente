// src/services/auth.service.js
// Autenticação privada: valida sessão Supabase + StaffUser.
// Garante: sem signup público, usuário só entra se existir em StaffUser e ativo.

const supabaseAuth = require("./supabase-auth.service");
const staffUser = require("./staff-user.service");
const auditLog = require("./audit-log.service");
const log = require("../lib/logger").child({ service: "auth" });

/**
 * Valida token Supabase e retorna StaffUser se autorizado.
 * - Verifica JWT no Supabase
 * - Busca em StaffUser por authUserId
 * - Bloqueia se não existir ou active=false
 * - Atualiza lastLoginAt em login ok
 * - Registra auditoria
 *
 * @param {string} accessToken - JWT do Supabase
 * @param {{ ip?: string, userAgent?: string }} opts - Para auditoria
 * @returns {{ staffUser: object } | { denied: true, reason: string, message: string }}
 */
async function verifySession(accessToken, opts = {}) {
  const { ip, userAgent } = opts;
  if (!accessToken || typeof accessToken !== "string") {
    return { denied: true, reason: "invalid_token", message: "Token inválido." };
  }

  const authUser = await supabaseAuth.verifyToken(accessToken.trim());
  if (!authUser) {
    await auditLog.logAction({
      action: "login_denied",
      resourceType: "auth",
      metadata: { reason: "invalid_token" },
      ip,
      userAgent,
    });
    return { denied: true, reason: "invalid_token", message: "Sessão inválida ou expirada." };
  }

  const staff = await staffUser.findByAuthUserId(authUser.id);
  if (!staff) {
    log.info({ email: authUser.email, authUserId: authUser.id }, "Login negado: usuário não autorizado");
    await auditLog.logAction({
      action: "login_denied",
      resourceType: "auth",
      metadata: { email: authUser.email, reason: "user_not_authorized" },
      ip,
      userAgent,
    });
    return {
      denied: true,
      reason: "user_not_authorized",
      message: "Usuário não autorizado. Entre em contato com o administrador.",
    };
  }

  if (!staff.active) {
    log.info({ email: staff.email }, "Login negado: usuário inativo");
    await auditLog.logAction({
      action: "login_denied",
      resourceType: "staff_user",
      resourceId: staff.id,
      metadata: { email: staff.email, reason: "user_inactive" },
      ip,
      userAgent,
    });
    return { denied: true, reason: "user_inactive", message: "Usuário inativo. Entre em contato com o administrador." };
  }

  await staffUser.updateLastLogin(staff.id);
  await auditLog.logAction({
    action: "login_success",
    resourceType: "staff_user",
    resourceId: staff.id,
    userId: staff.id,
    tenantId: staff.tenantId,
    metadata: { email: staff.email },
    ip,
    userAgent,
  });

  return { staffUser: staff };
}

/**
 * Solicita reset de senha. Só envia se o email existir em StaffUser e ativo.
 * Registra auditoria.
 *
 * @param {string} email
 * @param {{ ip?: string, userAgent?: string }} opts
 * @returns {{ ok: boolean, message: string }}
 */
async function requestPasswordReset(email, opts = {}) {
  const { ip, userAgent } = opts;
  const emailNorm = String(email || "")
    .trim()
    .toLowerCase();
  if (!emailNorm) return { ok: false, message: "E-mail obrigatório." };

  const staff = await staffUser.findByEmail(emailNorm);
  if (!staff || !staff.active) {
    await auditLog.logAction({
      action: "reset_password_denied",
      resourceType: "auth",
      metadata: { email: emailNorm, reason: "user_not_found_or_inactive" },
      ip,
      userAgent,
    });
    return {
      ok: false,
      message: "E-mail não encontrado ou não autorizado. Entre em contato com o administrador.",
    };
  }

  await supabaseAuth.resetPasswordForEmail(emailNorm);
  await auditLog.logAction({
    action: "reset_password_requested",
    resourceType: "staff_user",
    resourceId: staff.id,
    userId: staff.id,
    tenantId: staff.tenantId,
    metadata: { email: emailNorm },
    ip,
    userAgent,
  });

  return {
    ok: true,
    message: "Se o e-mail existir, você receberá as instruções para redefinir a senha.",
  };
}

/** Indica se auth privada está configurada */
function isAuthConfigured() {
  return supabaseAuth.isConfigured();
}

module.exports = {
  verifySession,
  requestPasswordReset,
  isAuthConfigured,
};
