// src/routes/admin-users.routes.js
// Gestão de usuários internos (apenas admin).
// Montar em /admin/users.

const express = require("express");
const crypto = require("crypto");
const supabaseAuth = require("../services/supabase-auth.service");
const staffUserService = require("../services/staff-user.service");
const staffInviteService = require("../services/staff-invite.service");
const auditLog = require("../services/audit-log.service");
const { authAdmin } = require("../middleware/auth.middleware");
const ENV = require("../config/env");

const router = express.Router();
router.use(authAdmin);

/** GET /admin/users — lista usuários (filtro por tenant, role, active) */
router.get("/", async (req, res) => {
  try {
    const { tenantId, role, active } = req.query;
    const users = await staffUserService.listStaffUsers({
      tenantId: tenantId || undefined,
      role: role || undefined,
      active: active === "true" ? true : active === "false" ? false : undefined,
    });
    res.json(
      users.map((u) => ({
        id: u.id,
        authUserId: u.authUserId,
        email: u.email,
        name: u.name,
        role: u.role,
        tenantId: u.tenantId,
        tenantName: u.tenant?.name,
        active: u.active,
        lastLoginAt: u.lastLoginAt,
        createdAt: u.createdAt,
        canViewOrders: u.canViewOrders,
        canSendMessages: u.canSendMessages,
        canManageCoupons: u.canManageCoupons,
        canManageSettings: u.canManageSettings,
        canManageUsers: u.canManageUsers,
        phone: u.phone,
        department: u.department,
      })),
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /admin/users/invites — gera link de primeiro acesso (e-mail autorizado) */
router.post("/invites", async (req, res) => {
  try {
    const { email, role, tenantId, department } = req.body || {};
    const inv = await staffInviteService.createInvite({
      email,
      role,
      tenantId: tenantId || null,
      department: department || null,
      invitedBy: req.staffUser?.name || null,
    });
    const base = ENV.APP_URL || "";
    const signupUrl = `${base}/?invite=${encodeURIComponent(inv.token)}`;
    await auditLog.logAction({
      tenantId: req.staffUser?.tenantId,
      userId: req.staffUser?.id,
      action: "staff_invite_created",
      resourceType: "staff_user",
      metadata: { email: inv.email, role: inv.role, tenantId: inv.tenantId },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.status(201).json({
      id: inv.id,
      email: inv.email,
      expiresAt: inv.expiresAt,
      signupUrl,
      token: inv.token,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** POST /admin/users — cria usuário (admin) */
router.post("/", async (req, res) => {
  try {
    const { email, password, name, role, tenantId, active, phone, department } = req.body;
    const staff = req.staffUser;
    if (!email || !name || !role) {
      return res.status(400).json({ error: "E-mail, nome e role obrigatórios." });
    }

    const pwd =
      password && String(password).length > 0
        ? String(password)
        : crypto.randomBytes(12).toString("base64url");
    try {
      staffUserService.validateStaffPassword(pwd);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    let authUser;
    try {
      authUser = await supabaseAuth.createAuthUser({
        email: email.trim().toLowerCase(),
        password: pwd,
        emailConfirm: true,
      });
    } catch (err) {
      return res.status(400).json({
        error: "auth_error",
        message: err.message || "Erro ao criar usuário no sistema de autenticação.",
      });
    }

    const created = await staffUserService.createStaffUser(
      {
        authUserId: authUser.id,
        email,
        name,
        role,
        tenantId,
        active: active !== false,
        phone,
        department,
      },
      staff?.name,
    );

    await auditLog.logAction({
      tenantId: staff?.tenantId,
      userId: staff?.id,
      action: "staff_user_created",
      resourceType: "staff_user",
      resourceId: created.id,
      metadata: { email: created.email, role: created.role, tenantId: created.tenantId },
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });

    res.status(201).json({
      id: created.id,
      email: created.email,
      name: created.name,
      role: created.role,
      tenantId: created.tenantId,
      active: created.active,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** PATCH /admin/users/:id */
router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body;
    const staff = req.staffUser;

    const updated = await staffUserService.updateStaffUser(id, body, staff?.id);
    if (!updated) return res.status(404).json({ error: "Usuário não encontrado." });

    await auditLog.logAction({
      tenantId: staff?.tenantId,
      userId: staff?.id,
      action: "staff_user_updated",
      resourceType: "staff_user",
      resourceId: id,
      metadata: body,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });

    res.json(updated);
  } catch (err) {
    res.status(err.message?.includes("inválida") ? 400 : 500).json({ error: err.message });
  }
});

/** POST /admin/users/:id/activate */
router.post("/:id/activate", async (req, res) => {
  const { id } = req.params;
  const updated = await staffUserService.activateStaffUser(id);
  if (!updated) return res.status(404).json({ error: "Usuário não encontrado." });
  await auditLog.logAction({
    userId: req.staffUser?.id,
    action: "staff_user_activated",
    resourceType: "staff_user",
    resourceId: id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
  });
  res.json({ ok: true, active: true });
});

/** POST /admin/users/:id/deactivate */
router.post("/:id/deactivate", async (req, res) => {
  try {
    const { id } = req.params;
    const updated = await staffUserService.deactivateStaffUser(id, req.staffUser?.id);
    if (!updated) return res.status(404).json({ error: "Usuário não encontrado." });
    await auditLog.logAction({
      userId: req.staffUser?.id,
      action: "staff_user_deactivated",
      resourceType: "staff_user",
      resourceId: id,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.json({ ok: true, active: false });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** POST /admin/users/:id/reset-password */
router.post("/:id/reset-password", async (req, res) => {
  const { id } = req.params;
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < staffUserService.MIN_STAFF_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Senha deve ter pelo menos ${staffUserService.MIN_STAFF_PASSWORD_LENGTH} caracteres.` });
  }
  const prisma = require("../lib/db");
  const target = await prisma.staff_users.findUnique({ where: { id } });
  if (!target) return res.status(404).json({ error: "Usuário não encontrado." });
  try {
    await supabaseAuth.updateUserPassword(target.authUserId, newPassword);
  } catch (err) {
    return res.status(400).json({ error: err.message || "Erro ao atualizar senha." });
  }
  await auditLog.logAction({
    userId: req.staffUser?.id,
    action: "staff_user_password_reset",
    resourceType: "staff_user",
    resourceId: id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
  });
  res.json({ ok: true });
});

module.exports = router;
