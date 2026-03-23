// src/services/supabase-auth.service.js
// Cliente Supabase para autenticação (server-side).
// NUNCA expor SUPABASE_SERVICE_ROLE_KEY no frontend.

const { createClient } = require("@supabase/supabase-js");
const ENV = require("../config/env");
const log = require("../lib/logger").child({ service: "supabase-auth" });

let _adminClient = null;

function getAdminClient() {
  if (!_adminClient) {
    const url = ENV.SUPABASE_URL;
    const key = ENV.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      log.warn("Supabase Admin não configurado (SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes)");
      return null;
    }
    _adminClient = createClient(url, key, { auth: { persistSession: false } });
  }
  return _adminClient;
}

/** Valida JWT e retorna payload do usuário ou null */
async function verifyToken(accessToken) {
  const supabase = getAdminClient();
  if (!supabase) return null;
  try {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(accessToken);
    if (error) {
      log.debug({ err: error.message }, "Token inválido");
      return null;
    }
    return user;
  } catch (err) {
    log.warn({ err: err.message }, "Erro ao verificar token");
    return null;
  }
}

/** Cria usuário no Supabase Auth (apenas admin) */
async function createAuthUser({ email, password, emailConfirm = true }) {
  const supabase = getAdminClient();
  if (!supabase) throw new Error("Supabase Admin não configurado");
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: emailConfirm,
  });
  if (error) throw error;
  return data.user;
}

/** Atualiza senha de usuário (apenas admin) */
async function updateUserPassword(authUserId, newPassword) {
  const supabase = getAdminClient();
  if (!supabase) throw new Error("Supabase Admin não configurado");
  const { data, error } = await supabase.auth.admin.updateUserById(authUserId, { password: newPassword });
  if (error) throw error;
  return data.user;
}

/** Envia email de reset de senha */
async function resetPasswordForEmail(email) {
  const supabase = getAdminClient();
  if (!supabase) throw new Error("Supabase Admin não configurado");
  const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${ENV.APP_URL}/reset-password`,
  });
  if (error) throw error;
  return data;
}

/** Desabilita signup público via API (configurar no Supabase Dashboard) */
function isConfigured() {
  return !!(ENV.SUPABASE_URL && ENV.SUPABASE_SERVICE_ROLE_KEY);
}

module.exports = {
  getAdminClient,
  verifyToken,
  createAuthUser,
  updateUserPassword,
  resetPasswordForEmail,
  isConfigured,
};
