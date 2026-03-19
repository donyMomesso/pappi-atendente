// src/services/chat-memory.service.js
// Histórico de conversa: salva em memória (rápido) E no banco (persistente).

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const MAX_MEMORY = 100;
const store = new Map(); // customerId → Message[]

async function push(customerId, role, text, sender = null) {
  // Memória
  if (!store.has(customerId)) store.set(customerId, []);
  const msgs = store.get(customerId);
  msgs.push({ role, text, sender, at: new Date().toISOString() });
  if (msgs.length > MAX_MEMORY) msgs.shift();

  // Banco (persistente)
  try {
    await prisma.message.create({
      data: {
        customerId,
        role,
        text,
        sender
      }
    });
  } catch (err) {
    console.error(`[ChatMemory] Erro ao salvar no banco:`, err.message);
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
    return rows.map(r => ({ role: r.role, text: r.text, sender: r.sender, at: r.createdAt.toISOString() }));
  } catch { return []; }
}

function clear(customerId) {
  store.delete(customerId);
}

module.exports = { push, get, clear };
