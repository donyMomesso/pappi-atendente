// src/services/message-retention.service.js
// Limpeza periódica de mensagens antigas para manter janela de 24h.

const prisma = require("../lib/db");
const messageDbCompat = require("../lib/message-db-compat");
const log = require("../lib/logger").child({ service: "message-retention" });

const RETAIN_MS = 24 * 60 * 60 * 1000;
const RUN_EVERY_MS = 30 * 60 * 1000; // a cada 30 min
let timer = null;

async function cleanupOldMessages() {
  if (!messageDbCompat.isMessagesTableAvailable()) return;
  const cutoff = new Date(Date.now() - RETAIN_MS);
  try {
    const res = await prisma.message.deleteMany({
      where: {
        OR: [
          { originalTimestamp: { lt: cutoff } },
          {
            AND: [{ originalTimestamp: null }, { createdAt: { lt: cutoff } }],
          },
        ],
      },
    });
    if (res?.count) {
      log.info({ removed: res.count, cutoff: cutoff.toISOString() }, "Limpeza 24h de mensagens concluída");
    }
  } catch (err) {
    log.warn({ err: err?.message }, "Falha na limpeza 24h de mensagens");
  }
}

function startScheduler() {
  if (timer) return;
  cleanupOldMessages().catch(() => {});
  timer = setInterval(() => {
    cleanupOldMessages().catch(() => {});
  }, RUN_EVERY_MS);
}

module.exports = { startScheduler, cleanupOldMessages };
