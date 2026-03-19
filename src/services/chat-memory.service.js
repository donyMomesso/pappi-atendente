// src/services/chat-memory.service.js
// Histórico de conversa: salva em memória (rápido) E no banco (persistente).

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const MAX_MEMORY = 100;
const store = new Map(); // customerId → Message[]

async function push(customerId, role, text, sender = null, mediaUrl = null, mediaType = "text", waMessageId = null) {
  const at = new Date().toISOString();

  // Memória
  if (!store.has(customerId)) store.set(customerId, []);
  const msgs = store.get(customerId);
  const msg = { role, text, sender, mediaUrl, mediaType, waMessageId, at };
  msgs.push(msg);
  if (msgs.length > MAX_MEMORY) msgs.shift();

  // Banco (persistente)
  try {
    await prisma.message.create({
      data: { customerId, role, text, sender, mediaUrl, mediaType, waMessageId }
    });
  } catch (err) {
    console.error(`[ChatMemory] Erro ao salvar no banco:`, err.message);
  }

  // Push em tempo real via WebSocket
  try {
    const socketService = require("./socket.service");
    socketService.emitMessage(customerId, msg);
  } catch {}
}

async function updateStatus(customerId, waMessageId, status) {
  try {
    await prisma.message.update({
      where: { waMessageId },
      data: { status }
    });
    // Atualiza memória se necessário
    const msgs = store.get(customerId);
    if (msgs) {
      const m = msgs.find(msg => msg.waMessageId === waMessageId);
      if (m) m.status = status;
    }
  } catch (err) {
    // Ignora se não encontrar a mensagem
  }
}

async function get(customerId) {
  // Tenta memória primeiro; se vazio busca últimas 100 do banco
  const mem = store.get(customerId) || [];
  if (mem.length) return mem;

  try {
    const rows = await prisma.message.findMany({
      where: { customerId },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    return rows.map(r => ({ 
      role: r.role, 
      text: r.text, 
      sender: r.sender, 
      mediaUrl: r.mediaUrl, 
      mediaType: r.mediaType, 
      status: r.status,
      at: r.createdAt.toISOString() 
    }));
  } catch { return []; }
}

function clear(customerId) {
  store.delete(customerId);
}

module.exports = { push, get, clear };
