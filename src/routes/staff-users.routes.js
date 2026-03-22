// src/routes/staff-users.routes.js
// CRUD de usuários internos (apenas admin)

const express = require("express");
const prisma = require("../lib/db");
const supabaseAuth = require("../services/supabase-auth.service");
const audit = require("../services/audit.service");
const { authAdmin } = require("../middleware/auth.middleware");

const router = express.Router();
router.use(authAdmin);

/** GET /admin/users — lista usuários (filtro por tenant, role) */
router.get("/", async (req, res) => {
  try {
    const { tenantId, role, active } = req.query;
    const where = {};
    if (tenantId) where.tenantId = tenantId;
    if (role) where.role = role;
    if (active !== undefined) where.active = active === "true";

    const users = await prisma.staffUser.findMany({
      where,
      orderBy: [{ role: "asc" }, { name: "asc" }],
      include: { tenant: { select: { id: true, name: true } } },
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
      })),
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /admin/users — cria usuário (admin) */
router.post("/", async (req, res) => {
  try {
    const { email, password, name, role, tenantId, active } = req.body;
    const staff = req.staffUser;
    if (!email || !name || !role) {
      return res.status(400).json({ error: "E-mail, nome e role obrigatórios." });
    }
    if (!["admin", "manager", "attendant"].includes(role)) {
      return res.status(400).json({ error: "Role inválida. Use: admin, manager, attendant." });
    }
    if (role !== "admin" && !tenantId) {
      return res.status(400).json({ error: "Manager e attendant precisam de tenant_id." });
    }

    const emailNorm = email.trim().toLowerCase();
    const existing = await prisma.staffUser.findFirst({ where: { email: emailNorm } });
    if (existing) return res.status(400).json({ error: "E-mail já cadastrado." });

    let authUser;
    try {
      authUser = await supabaseAuth.createAuthUser({
        email: emailNorm,
        password: password || require("crypto").randomUUID().slice(0, 12),
        emailConfirm: true,
      });
    } catch (err) {
      return res.status(400).json({
        error: "auth_error",
        message: err.message || "Erro ao criar usuário no sistema de autenticação.",
      });
    }

    const canManageUsers = role === "admin";
    const canManageSettings = role === "admin" || role === "manager";
    const canManageCoupons = role === "admin" || role === "manager";

    const created = await prisma.staffUser.create({
      data: {
        authUserId: authUser.id,
        email: emailNorm,
        name: String(name).trim(),
        role,
        tenantId: role === "admin" ? null : tenantId,
        active: active !== false,
        invitedBy: staff?.name,
        canViewOrders: true,
        canSendMessages: true,
        canManageCoupons,
        canManageSettings,
        canManageUsers,
      },
    });

    await audit.logAction({
      tenantId: staff?.tenantId,
      userId: staff?.id,
      action: "staff_user_created",
      resourceType: "staff_user",
      resourceId: created.id,
      metadata: { email: emailNorm, role, tenantId },
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
    res.status(500).json({ error: err.message });
  }
});

/** PATCH /admin/users/:id */
router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, role, tenantId, active, canViewOrders, canSendMessages, canManageCoupons, canManageSettings, canManageUsers } =
      req.body;
    const staff = req.staffUser;

    const user = await prisma.staffUser.findUnique({ where: { id } });
    if (!user) return res.status(404).json({ error: "Usuário não encontrado." });

    const data = {};
    if (name !== undefined) data.name = String(name).trim();
    if (role !== undefined) {
      if (!["admin", "manager", "attendant"].includes(role)) return res.status(400).json({ error: "Role inválida." });
      data.role = role;
    }
    if (tenantId !== undefined) data.tenantId = (data.role || user.role) === "admin" ? null : tenantId;
    if (active !== undefined) data.active = !!active;
    if (canViewOrders !== undefined) data.canViewOrders = !!canViewOrders;
    if (canSendMessages !== undefined) data.canSendMessages = !!canSendMessages;
    if (canManageCoupons !== undefined) data.canManageCoupons = !!canManageCoupons;
    if (canManageSettings !== undefined) data.canManageSettings = !!canManageSettings;
    if (canManageUsers !== undefined) data.canManageUsers = !!canManageUsers;

    const updated = await prisma.staffUser.update({ where: { id }, data });

    await audit.logAction({
      tenantId: staff?.tenantId,
      userId: staff?.id,
      action: "staff_user_updated",
      resourceType: "staff_user",
      resourceId: id,
      metadata: data,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /admin/users/:id/activate */
router.post("/:id/activate", async (req, res) => {
  const { id } = req.params;
  const user = await prisma.staffUser.findUnique({ where: { id } });
  if (!user) return res.status(404).json({ error: "Usuário não encontrado." });
  await prisma.staffUser.update({ where: { id }, data: { active: true } });
  await audit.logAction({
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
  const { id } = req.params;
  const user = await prisma.staffUser.findUnique({ where: { id } });
  if (!user) return res.status(404).json({ error: "Usuário não encontrado." });
  if (user.id === req.staffUser?.id) return res.status(400).json({ error: "Não é possível desativar a si mesmo." });
  await prisma.staffUser.update({ where: { id }, data: { active: false } });
  await audit.logAction({
    userId: req.staffUser?.id,
    action: "staff_user_deactivated",
    resourceType: "staff_user",
    resourceId: id,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
  });
  res.json({ ok: true, active: false });
});

/** POST /admin/users/:id/reset-password */
router.post("/:id/reset-password", async (req, res) => {
  const { id } = req.params;
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: "Senha deve ter pelo menos 6 caracteres." });
  }
  const user = await prisma.staffUser.findUnique({ where: { id } });
  if (!user) return res.status(404).json({ error: "Usuário não encontrado." });
  try {
    await supabaseAuth.updateUserPassword(user.authUserId, newPassword);
  } catch (err) {
    return res.status(400).json({ error: err.message || "Erro ao atualizar senha." });
  }
  await audit.logAction({
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
