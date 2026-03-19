// src/services/session.service.js
// Sessões persistidas no banco (Config table) com cache em memória.
// Sobrevive a restarts do servidor.

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const cache = new Map(); // key → session object
const TTL_MS = 30 * 60 * 1000; // 30 minutos sem atividade = limpa sessão

function sessionKey(tenantId, phone) {
  return `session:${tenantId}:${phone}`;
}

async function get(tenantId, phone) {
  const k = sessionKey(tenantId, phone);

  // Cache em memória primeiro
  if (cache.has(k)) return cache.get(k);

  // Busca no banco
  try {
    const row = await prisma.config.findUnique({ where: { key: k } });
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      // Verifica TTL
      if (parsed._updatedAt && Date.now() - parsed._updatedAt > TTL_MS) {
        await clear(tenantId, phone);
        return newSession();
      }
      cache.set(k, parsed);
      return parsed;
    }
  } catch {}

  return newSession();
}

async function save(tenantId, phone, session) {
  const k = sessionKey(tenantId, phone);
  session._updatedAt = Date.now();
  cache.set(k, session);

  // Persiste no banco de forma assíncrona (não bloqueia)
  prisma.config.upsert({
    where: { key: k },
    create: { key: k, value: JSON.stringify(session) },
    update: { value: JSON.stringify(session) },
  }).catch(err => console.error("[Session] Erro ao salvar:", err.message));
}

async function clear(tenantId, phone) {
  const k = sessionKey(tenantId, phone);
  cache.delete(k);
  prisma.config.deleteMany({ where: { key: k } }).catch(() => {});
}

function newSession() {
  return { step: "MENU", cart: [], orderHistory: [], _updatedAt: Date.now() };
}

// Limpeza periódica de sessões expiradas no banco
setInterval(async () => {
  try {
    const rows = await prisma.config.findMany({
      where: { key: { startsWith: "session:" } },
      select: { key: true, value: true },
    });
    for (const row of rows) {
      try {
        const s = JSON.parse(row.value);
        if (s._updatedAt && Date.now() - s._updatedAt > TTL_MS) {
          await prisma.config.deleteMany({ where: { key: row.key } });
          cache.delete(row.key);
        }
      } catch {}
    }
  } catch {}
}, 15 * 60 * 1000); // roda a cada 15 min

module.exports = { get, save, clear };
