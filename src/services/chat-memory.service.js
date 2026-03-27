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

/** Evita linha duplicada no painel: eco Cloud da mesma msg já salva como "bot". */
const OUTBOUND_ECHO_DEDUP_TTL_MS = 120_000;
const recentBotOutboundByCustomer = new Map(); // customerId → { norm, at }[]

function normalizeForOutboundDedup(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function recordBotOutbound(customerId, text) {
  const norm = normalizeForOutboundDedup(text);
  if (!norm) return;
  const now = Date.now();
  let arr = recentBotOutboundByCustomer.get(customerId) || [];
  arr.push({ norm, at: now });
  if (arr.length > 12) arr = arr.slice(-12);
  recentBotOutboundByCustomer.set(customerId, arr);
}

/** true = eco da API é duplicata de mensagem nossa; não persistir de novo como "human". */
function shouldSkipOutboundEcho(customerId, echoText) {
  const norm = normalizeForOutboundDedup(echoText);
  if (!norm) return false;
  const arr = recentBotOutboundByCustomer.get(customerId) || [];
  const now = Date.now();
  for (let i = arr.length - 1; i >= 0; i--) {
    if (now - arr[i].at > OUTBOUND_ECHO_DEDUP_TTL_MS) continue;
    if (arr[i].norm === norm) return true;
  }
  return false;
}

function resolveMsgMillis(m) {
  const raw = m?.originalTimestamp || m?.at || m?.createdAt;
  const d = raw ? new Date(raw) : new Date(0);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : 0;
}

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

  if (role === "bot" || role === "assistant") {
    recordBotOutbound(customerId, text);
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
    return [...entry.msgs].sort((a, b) => resolveMsgMillis(a) - resolveMsgMillis(b));
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
    const msgs = rows
      .map((r) => messageDbCompat.mapRowToClientMessage(r))
      .sort((a, b) => resolveMsgMillis(a) - resolveMsgMillis(b));

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

module.exports = { push, get, clear, updateStatus, shouldSkipOutboundEcho };
