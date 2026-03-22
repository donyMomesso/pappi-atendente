// src/services/audit.service.js
// Re-exporta audit-log.service.js para compatibilidade com código existente.

const { logAction } = require("./audit-log.service");
module.exports = { logAction };
