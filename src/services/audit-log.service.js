// src/services/audit-log.service.js
// Função central de auditoria para ações do painel e admin.

const prisma = require("../lib/db");
const log = require("../lib/logger").child({ service: "audit-log" });

/**
 * Registra uma ação no log de auditoria.
 *
 * @param {Object} opts
 * @param {string} opts.action - Ex: login_success, staff_user_created
 * @param {string} [opts.resourceType] - Ex: staff_user, tenant
 * @param {string} [opts.resourceId]
 * @param {string} [opts.userId] - staff_user.id
 * @param {string} [opts.tenantId]
 * @param {Object} [opts.metadata] - Objeto serializado como JSON
 * @param {string} [opts.ip]
 * @param {string} [opts.userAgent]
 */
async function logAction(opts) {
  const { tenantId, userId, action, resourceType, resourceId, metadata, ip, userAgent } = opts;
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: tenantId || null,
        userId: userId || null,
        action,
        resourceType: resourceType || null,
        resourceId: resourceId || null,
        metadata: metadata ? JSON.stringify(metadata) : null,
        ip: ip || null,
        userAgent: userAgent || null,
      },
    });
  } catch (err) {
    log.error({ err: err.message }, "Erro ao registrar auditoria");
  }
}

module.exports = { logAction };
