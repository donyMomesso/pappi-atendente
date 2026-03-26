// src/services/chat-memory.service.js
// Histórico de conversa: salva em memória (rápido) E no banco (persistente).
// CORREÇÕES:
//   - Usa singleton do PrismaClient (evita pool esgotado)
//   - Limpeza periódica do Map em memória (evita memory leak)
//   - updateStatus propagado via Socket.io

const prisma = require("../lib/db");
const messageDbCompat = require("../lib/message-db-compat");

const MAX_MEMORY = 100;
const STORE_TTL_MS = 60 * 60 * 1000; // 1h sem acesso → remove do Map
const store = new Map(); // customerId → { msgs: Message[], lastAccess: number }

function getEntry(customerId) {
  let entry = store.get(customerId);
  if (!entry) {
    entry = { msgs: [], lastAccess: Date.now() };
    store.set(customerId, entry);
  }
  entry.lastAccess = Date.now();
  return entry;
}

async function push(
  customerId,
  role,
  text,
  sender = null,
  mediaUrl = null,
  mediaType = "text",
  waMessageId = null,
  senderEmail = null,
  originalTimestamp = null,
) {
  const normalizedOriginalTs = originalTimestamp ? new Date(originalTimestamp) : null;
  const safeOriginalTs =
    normalizedOriginalTs && !Number.isNaN(normalizedOriginalTs.getTime()) ? normalizedOriginalTs : null;
  const at = (safeOriginalTs || new Date()).toISOString();
  const msg = {
    role,
    text,
    sender,
    senderEmail,
    mediaUrl,
    mediaType,
    waMessageId,
    originalTimestamp: safeOriginalTs ? safeOriginalTs.toISOString() : null,
    at,
  };

  // Memória
  const entry = getEntry(customerId);
  entry.msgs.push(msg);
  if (entry.msgs.length > MAX_MEMORY) entry.msgs.shift();

  // Banco (persistente)
  if (messageDbCompat.isMessagesTableAvailable()) {
    try {
      await prisma.message.create({
        data: messageDbCompat.buildMessageCreateData({
          customerId,
          role,
          text,
          sender,
          senderEmail,
          mediaUrl,
          mediaType,
          waMessageId,
          originalTimestamp: safeOriginalTs,
        }),
        select: messageDbCompat.getMessageRowSelect(),
      });
    } catch (err) {
      console.error("[ChatMemory] Erro ao salvar no banco:", err.message);
    }
  }

  // Push em tempo real via WebSocket
  try {
    const socketService = require("./socket.service");
    socketService.emitMessage(customerId, msg);
  } catch {}
}

async function updateStatus(customerId, waMessageId, status) {
  if (!waMessageId) return;
  try {
    if (messageDbCompat.isMessagesTableAvailable()) {
      await prisma.message.updateMany({
        where: { waMessageId },
        data: { status },
      });
    }

    // Atualiza memória
    const entry = store.get(customerId);
    if (entry) {
      const m = entry.msgs.find((msg) => msg.waMessageId === waMessageId);
      if (m) m.status = status;
    }

    // Propaga status do check azul para o painel
    try {
      const socketService = require("./socket.service");
      socketService.emitMessageStatus(customerId, waMessageId, status);
    } catch {}
  } catch {
    // Ignora se não encontrar a mensagem
  }
}

async function get(customerId) {
  const entry = store.get(customerId);
  if (entry?.msgs?.length) {
    entry.lastAccess = Date.now();
    return entry.msgs;
  }

  try {
    if (!messageDbCompat.isMessagesTableAvailable()) {
      return [];
    }
    const rows = await prisma.message.findMany({
      where: { customerId },
      orderBy: { createdAt: "asc" },
      take: 100,
      select: messageDbCompat.getMessageRowSelect(),
    });
    const msgs = rows.map((r) => messageDbCompat.mapRowToClientMessage(r));

    // Popula cache
    const e = getEntry(customerId);
    e.msgs = msgs;
    return msgs;
  } catch {
    return [];
  }
}

function clear(customerId) {
  store.delete(customerId);
}

// ── Limpeza periódica do Map (evita memory leak) ──────────────
// Remove customers que não interagiram há mais de STORE_TTL_MS
setInterval(
  () => {
    const now = Date.now();
    let removed = 0;
    for (const [id, entry] of store.entries()) {
      if (now - entry.lastAccess > STORE_TTL_MS) {
        store.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`[ChatMemory] Limpeza: ${removed} customers removidos do cache. Restam: ${store.size}`);
    }
  },
  30 * 60 * 1000,
); // roda a cada 30 min

module.exports = { push, get, clear, updateStatus };
