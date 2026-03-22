// src/routes/auth.routes.js
// Autenticação corporativa: /auth/me, /auth/logout, /auth/reset-password

const express = require("express");
const prisma = require("../lib/db");
const authService = require("../services/auth.service");
const staffUserService = require("../services/staff-user.service");
const auditLog = require("../services/audit-log.service");
const { requireStaffAuth } = require("../middleware/auth.middleware");

const router = express.Router();

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
