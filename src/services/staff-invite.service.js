// Convites de cadastro staff: e-mail e permissões fixados pelo admin.

const crypto = require("crypto");
const prisma = require("../lib/db");

const INVITE_VALID_DAYS = 14;

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

async function findPendingForEmail(emailNorm) {
  const now = new Date();
  return prisma.staff_user_invites.findFirst({
    where: {
      email: emailNorm,
      consumedAt: null,
      expiresAt: { gt: now },
    },
  });
}

/**
 * @param {{ email: string, role: string, tenantId?: string|null, department?: string|null, invitedBy?: string|null }}
 */
async function createInvite({ email, role, tenantId, department, invitedBy }) {
  const emailNorm = normalizeEmail(email);
  if (!emailNorm || !role) throw new Error("E-mail e cargo são obrigatórios.");
  if (!["admin", "manager", "attendant"].includes(role)) {
    throw new Error("Cargo inválido.");
  }
  if (role !== "admin" && !tenantId) {
    throw new Error("Atendente e manager precisam de tenant.");
  }

  const existingUser = await prisma.staff_users.findFirst({ where: { email: emailNorm } });
  if (existingUser) throw new Error("Este e-mail já possui usuário cadastrado.");

  const pending = await findPendingForEmail(emailNorm);
  if (pending) throw new Error("Já existe um convite pendente para este e-mail.");

  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + INVITE_VALID_DAYS * 86_400_000);

  return prisma.staff_user_invites.create({
    data: {
      email: emailNorm,
      role,
      tenantId: role === "admin" ? null : tenantId || null,
      department: department ? String(department).trim() || null : null,
      token,
      expiresAt,
      invitedBy: invitedBy || null,
    },
  });
}

async function findValidByToken(token) {
  if (!token || typeof token !== "string") return null;
  const now = new Date();
  return prisma.staff_user_invites.findFirst({
    where: {
      token: token.trim(),
      consumedAt: null,
      expiresAt: { gt: now },
    },
    include: { tenant: { select: { id: true, name: true } } },
  });
}

async function markConsumed(id) {
  return prisma.staff_user_invites.update({
    where: { id },
    data: { consumedAt: new Date() },
  });
}

module.exports = {
  createInvite,
  findValidByToken,
  findPendingForEmail,
  markConsumed,
  normalizeEmail,
  INVITE_VALID_DAYS,
};
