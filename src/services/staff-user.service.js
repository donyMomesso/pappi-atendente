// src/services/staff-user.service.js
// Lógica interna de usuários internos (StaffUser).
// Usado por rotas admin e middlewares de autorização.

const prisma = require("../lib/db");
const log = require("../lib/logger").child({ service: "staff-user" });

const VALID_ROLES = ["admin", "manager", "attendant"];

/** Valida se a role é permitida */
function validateRole(role) {
  if (!role || !VALID_ROLES.includes(role)) {
    throw new Error(`Role inválida. Use: ${VALID_ROLES.join(", ")}.`);
  }
}

/** Valida que manager e attendant tenham tenant obrigatório */
function validateTenantRequired(role, tenantId) {
  if (role !== "admin" && !tenantId) {
    throw new Error("Manager e attendant precisam de tenantId.");
  }
}

/** Lista usuários internos com filtros */
async function listStaffUsers(filters = {}) {
  const { tenantId, role, active } = filters;
  const where = {};
  if (tenantId) where.tenantId = tenantId;
  if (role) where.role = role;
  if (active !== undefined) where.active = active === true || active === "true";

  return prisma.staffUser.findMany({
    where,
    orderBy: [{ role: "asc" }, { name: "asc" }],
    include: { tenant: { select: { id: true, name: true } } },
  });
}

/** Busca usuário por email (normalizado) */
async function findByEmail(email) {
  if (!email) return null;
  const emailNorm = String(email).trim().toLowerCase();
  return prisma.staffUser.findFirst({ where: { email: emailNorm } });
}

/** Busca usuário por authUserId (Supabase auth.users.id) */
async function findByAuthUserId(authUserId) {
  if (!authUserId) return null;
  return prisma.staffUser.findUnique({
    where: { authUserId: String(authUserId) },
    include: { tenant: { select: { id: true, name: true } } },
  });
}

/** Cria usuário interno. Valida role e tenant. */
async function createStaffUser(data, invitedBy = null) {
  const { email, name, role, tenantId, active = true } = data;
  if (!email || !name || !role) {
    throw new Error("E-mail, nome e role obrigatórios.");
  }
  validateRole(role);
  validateTenantRequired(role, tenantId);

  const emailNorm = String(email).trim().toLowerCase();
  const existing = await findByEmail(emailNorm);
  if (existing) {
    throw new Error("E-mail já cadastrado.");
  }

  const finalTenantId = role === "admin" ? null : tenantId;
  return prisma.staffUser.create({
    data: {
      authUserId: data.authUserId,
      email: emailNorm,
      name: String(name).trim(),
      role,
      tenantId: finalTenantId,
      active,
      invitedBy: invitedBy || null,
      canViewOrders: data.canViewOrders !== false,
      canSendMessages: data.canSendMessages !== false,
      canManageCoupons: data.canManageCoupons ?? (role === "admin" || role === "manager"),
      canManageSettings: data.canManageSettings ?? (role === "admin" || role === "manager"),
      canManageUsers: data.canManageUsers ?? (role === "admin"),
    },
  });
}

/** Atualiza usuário interno */
async function updateStaffUser(id, data, currentUserId = null) {
  const user = await prisma.staffUser.findUnique({ where: { id } });
  if (!user) return null;

  const allowed = ["name", "role", "tenantId", "active", "canViewOrders", "canSendMessages", "canManageCoupons", "canManageSettings", "canManageUsers"];
  const updates = {};
  for (const k of allowed) {
    if (data[k] !== undefined) {
      if (k === "role") {
        validateRole(data.role);
        validateTenantRequired(data.role, data.tenantId ?? user.tenantId);
      }
      if (k === "tenantId" && (data.role || user.role) === "admin") {
        updates[k] = null;
      } else if (k === "tenantId") {
        updates[k] = data.tenantId;
      } else if (typeof data[k] === "boolean") {
        updates[k] = data[k];
      } else if (k === "name") {
        updates[k] = String(data[k]).trim();
      } else {
        updates[k] = data[k];
      }
    }
  }

  if (Object.keys(updates).length === 0) return user;

  return prisma.staffUser.update({ where: { id }, data: updates });
}

/** Ativa usuário */
async function activateStaffUser(id) {
  const user = await prisma.staffUser.findUnique({ where: { id } });
  if (!user) return null;
  return prisma.staffUser.update({ where: { id }, data: { active: true } });
}

/** Desativa usuário. Impede auto-desativação. */
async function deactivateStaffUser(id, currentStaffUserId) {
  const user = await prisma.staffUser.findUnique({ where: { id } });
  if (!user) return null;
  if (currentStaffUserId && user.id === currentStaffUserId) {
    throw new Error("Não é possível desativar a si mesmo.");
  }
  return prisma.staffUser.update({ where: { id }, data: { active: false } });
}

/** Atualiza lastLoginAt após login bem-sucedido */
async function updateLastLogin(id) {
  return prisma.staffUser.update({
    where: { id },
    data: { lastLoginAt: new Date() },
  });
}

module.exports = {
  VALID_ROLES,
  validateRole,
  validateTenantRequired,
  listStaffUsers,
  findByEmail,
  findByAuthUserId,
  createStaffUser,
  updateStaffUser,
  activateStaffUser,
  deactivateStaffUser,
  updateLastLogin,
};
