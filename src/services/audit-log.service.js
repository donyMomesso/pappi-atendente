// src/services/audit-log.service.js
// Função central de auditoria para ações do painel e admin.

const prisma = require("../lib/db");
const log = require("../lib/logger").child({ service: "audit-log" });
const fallbackBuffer = [];
const FALLBACK_LIMIT = 500;

function pushFallback(entry) {
  fallbackBuffer.unshift(entry);
  if (fallbackBuffer.length > FALLBACK_LIMIT) fallbackBuffer.length = FALLBACK_LIMIT;
}

function getAuditModel() {
  if (prisma.auditLog && typeof prisma.auditLog.create === "function") return prisma.auditLog;
  if (prisma.audit_logs && typeof prisma.audit_logs.create === "function") return prisma.audit_logs;
  return null;
}

function safeJsonParse(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

/**
 * Registra uma ação no log de auditoria.
 */
async function logAction(opts) {
  const { tenantId, userId, action, resourceType, resourceId, metadata, ip, userAgent } = opts || {};
  const model = getAuditModel();
  if (!model) {
    log.warn("Modelo de auditoria indisponível no Prisma Client");
    pushFallback({
      id: `fallback-${Date.now()}`, tenantId: tenantId || null, userId: userId || null, action: action || "unknown_action",
      resourceType: resourceType || null, resourceId: resourceId || null, metadata: metadata || null, ip: ip || null, userAgent: userAgent || null, createdAt: new Date(), fallback: true,
    });
    return false;
  }
  try {
    await model.create({
      data: {
        tenantId: tenantId || null,
        userId: userId || null,
        action: action || "unknown_action",
        resourceType: resourceType || null,
        resourceId: resourceId || null,
        metadata: metadata ? JSON.stringify(metadata) : null,
        ip: ip || null,
        userAgent: userAgent || null,
      },
    });
    return true;
  } catch (err) {
    log.error({ err: err.message, action, tenantId, userId }, "Erro ao registrar auditoria");
    pushFallback({
      id: `fallback-${Date.now()}`, tenantId: tenantId || null, userId: userId || null, action: action || "unknown_action",
      resourceType: resourceType || null, resourceId: resourceId || null, metadata: metadata || null, ip: ip || null, userAgent: userAgent || null, createdAt: new Date(), fallback: true, error: err.message,
    });
    return false;
  }
}

async function listRecent({ tenantId, limit = 50 } = {}) {
  const model = getAuditModel();
  if (!model || typeof model.findMany !== "function") {
    return fallbackBuffer
      .filter((l) => (!tenantId || l.tenantId === tenantId))
      .slice(0, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200))
      .map((l) => ({ ...l, metadata: safeJsonParse(l.metadata) }));
  }
  const where = {};
  if (tenantId) where.tenantId = tenantId;
  const rows = await model.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200),
  }).catch(() => []);
  return rows.map((l) => ({
    id: l.id,
    tenantId: l.tenantId,
    userId: l.userId,
    action: l.action,
    resourceType: l.resourceType,
    resourceId: l.resourceId,
    metadata: safeJsonParse(l.metadata),
    ip: l.ip,
    userAgent: l.userAgent,
    createdAt: l.createdAt,
  }));
}

module.exports = { logAction, listRecent, safeJsonParse };
