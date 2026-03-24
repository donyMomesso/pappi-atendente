// src/routes/auth.routes.js
// Autenticação corporativa: /auth/me, /auth/logout, /auth/reset-password

const express = require("express");
const authService = require("../services/auth.service");
const staffUserService = require("../services/staff-user.service");
const staffInviteService = require("../services/staff-invite.service");
const auditLog = require("../services/audit-log.service");
const { requireStaffAuth } = require("../middleware/auth.middleware");

const router = express.Router();

/** GET /auth/invite-preview?token= — dados públicos do convite (e-mail travado no cadastro) */
router.get("/invite-preview", async (req, res) => {
  try {
    const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
    if (!token) return res.status(400).json({ error: "token_obrigatorio" });
    const inv = await staffInviteService.findValidByToken(token);
    if (!inv) return res.status(404).json({ error: "convite_invalido", message: "Convite inválido ou expirado." });
    const roleLabel =
      inv.role === "admin" ? "Administrador" : inv.role === "manager" ? "Coordenador (Manager)" : "Atendente";
    res.json({
      email: inv.email,
      role: inv.role,
      roleLabel,
      department: inv.department || null,
      tenantName: inv.tenant?.name || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /auth/complete-invite — primeiro acesso (senha + nome); e-mail vem do convite */
router.post("/complete-invite", async (req, res) => {
  try {
    const { token, name, password, phone } = req.body || {};
    if (!token || typeof token !== "string") {
      return res.status(400).json({ error: "token_obrigatorio", message: "Link de convite inválido." });
    }
    const result = await authService.completeStaffInvite(
      { token: token.trim(), name, password, phone },
      { ip: req.ip, userAgent: req.headers["user-agent"] },
    );
    if (!result.ok) return res.status(400).json({ error: "cadastro_negado", message: result.message });
    res.json({ ok: true, message: result.message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /auth/me — retorna usuário logado (requer Bearer token) */
router.get("/me", requireStaffAuth, async (req, res) => {
  try {
    const staff = req.staffUser;
    if (!staff) return res.status(401).json({ error: "unauthorized" });

    const prevLogin = staff.lastLoginAt ? new Date(staff.lastLoginAt).getTime() : 0;
    const now = Date.now();
    if (now - prevLogin > 60 * 60 * 1000) {
      await auditLog.logAction({
        userId: staff.id,
        tenantId: staff.tenantId,
        action: "login_success",
        resourceType: "staff_user",
        resourceId: staff.id,
        metadata: { email: staff.email },
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
    }
    await staffUserService.updateLastLogin(staff.id);

    res.json({
      id: staff.id,
      authUserId: staff.authUserId,
      email: staff.email,
      name: staff.name,
      role: staff.role,
      tenantId: staff.tenantId,
      active: staff.active,
      permissions: {
        canViewOrders: staff.canViewOrders,
        canSendMessages: staff.canSendMessages,
        canManageCoupons: staff.canManageCoupons,
        canManageSettings: staff.canManageSettings,
        canManageUsers: staff.canManageUsers,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /auth/logout — confirma logout (cliente limpa sessão) */
router.post("/logout", requireStaffAuth, async (req, res) => {
  res.json({ ok: true });
});

/** POST /auth/reset-password — solicita reset (envia email) */
router.post("/reset-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "E-mail obrigatório." });
    }
    const result = await authService.requestPasswordReset(email, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    if (!result.ok) {
      return res.status(400).json({ error: "user_not_authorized", message: result.message });
    }
    res.json({ ok: true, message: result.message });
  } catch (err) {
    return res.status(400).json({
      error: err.message.includes("não autorizado") ? "user_not_authorized" : "bad_request",
      message: err.message,
    });
  }
});

/** GET /auth/config — configuração pública para o cliente (url, anon key) */
router.get("/config", (_req, res) => {
  const ENV = require("../config/env");
  const configured = !!(ENV.SUPABASE_URL && ENV.SUPABASE_ANON_KEY);
  res.json({
    supabaseUrl: ENV.SUPABASE_URL || "",
    supabaseAnonKey: ENV.SUPABASE_ANON_KEY || "",
    useStaffAuth: configured && ENV.USE_STAFF_AUTH,
  });
});

module.exports = router;
