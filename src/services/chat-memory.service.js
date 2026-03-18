// src/services/chat-memory.service.js
// Armazena as últimas N mensagens de cada cliente em memória (sem persistência).
// Suficiente para o atendente ver o contexto da conversa.
// Perde ao reiniciar o servidor — intencional para não sobrecarregar o banco.

const MAX_MSGS = 100;

// Map<customerId, Message[]>
const store = new Map();

// role: "customer" | "attendant" | "bot"
function push(customerId, role, text, sender = null) {
  if (!store.has(customerId)) store.set(customerId, []);
  const msgs = store.get(customerId);
  msgs.push({ role, text, sender, at: new Date().toISOString() });
  if (msgs.length > MAX_MSGS) msgs.shift();
}

function get(customerId) {
  return store.get(customerId) || [];
}

function clear(customerId) {
  store.delete(customerId);
}

module.exports = { push, get, clear };
