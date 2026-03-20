// src/services/session.service.js
// Sessões persistidas no banco (Config table) com cache em memória.
// CORREÇÕES:
//   - Usa singleton do PrismaClient
//   - Mutex por chave para evitar race condition em webhooks simultâneos
//   - Namespace exclusivo "sess:" para evitar conflito com outras configs
//   - Limpeza de sessões expiradas mais segura

const prisma = require("../lib/db");

const cache   = new Map();   // key → session object
const locks   = new Map();   // key → Promise (mutex simples)
const TTL_MS  = 30 * 60 * 1000; // 30 min

function sessionKey(tenantId, phone) {
  // Namespace "sess:" exclusivo — nunca conflita com "baileys:auth:", "attendants", etc.
  return `sess:${tenantId}:${phone}`;
}

// ── Mutex simples por chave ───────────────────────────────────
// Evita race condition quando dois webhooks chegam simultaneamente
// para o mesmo usuário (ex: duplo envio rápido no WhatsApp).
async function withLock(key, fn) {
  while (locks.has(key)) {
    await locks.get(key);
  }
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  locks.set(key, promise);
  try {
    return await fn();
  } finally {
    locks.delete(key);
    resolve();
  }
}

async function get(tenantId, phone) {
  const k = sessionKey(tenantId, phone);

  if (cache.has(k)) return cache.get(k);

  try {
    const row = await prisma.config.findUnique({ where: { key: k } });
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      if (parsed._updatedAt && Date.now() - parsed._updatedAt > TTL_MS) {
        await _clear(k);
        return newSession();
      }
      cache.set(k, parsed);
      return parsed;
    }
  } catch (err) {
    console.error("[Session] Erro ao carregar:", err.message);
  }

  return newSession();
}

async function save(tenantId, phone, session) {
  const k = sessionKey(tenantId, phone);
  session._updatedAt = Date.now();
  cache.set(k, session);

  prisma.config.upsert({
    where:  { key: k },
    create: { key: k, value: JSON.stringify(session) },
    update: { value: JSON.stringify(session) },
  }).catch(err => console.error("[Session] Erro ao salvar:", err.message));
}

async function clear(tenantId, phone) {
  await _clear(sessionKey(tenantId, phone));
}

async function _clear(k) {
  cache.delete(k);
  prisma.config.deleteMany({ where: { key: k } }).catch(() => {});
}

function newSession() {
  return { step: "MENU", cart: [], orderHistory: [], _updatedAt: Date.now() };
}

// Exporta withLock para uso no bot.handler
module.exports = { get, save, clear, withLock, sessionKey };

// ── Limpeza periódica de sessões expiradas ───────────────────
// Só deleta chaves com prefixo "sess:" — nunca toca Baileys ou outras configs
setInterval(async () => {
  try {
    const rows = await prisma.config.findMany({
      where:  { key: { startsWith: "sess:" } },
      select: { key: true, value: true },
    });
    for (const row of rows) {
      try {
        const s = JSON.parse(row.value);
        if (s._updatedAt && Date.now() - s._updatedAt > TTL_MS) {
          await _clear(row.key);
        }
      } catch {}
    }
  } catch {}
}, 15 * 60 * 1000);
