// src/lib/rate-limiter.js
// Rate limiting por telefone com sliding window em memória.
// Protege contra spam, dreno de cota Gemini e flood de pedidos.

// windowMs → tamanho da janela em ms
// max      → máximo de eventos na janela
// store    → Map de phone → [timestamps]

const store = new Map();

// Limpeza periódica de entradas expiradas (evita memory leak)
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000; // remove entradas > 5 min
  for (const [key, timestamps] of store.entries()) {
    const fresh = timestamps.filter(t => t > cutoff);
    if (fresh.length === 0) store.delete(key);
    else store.set(key, fresh);
  }
}, 2 * 60 * 1000);

/**
 * Verifica se a chave ultrapassou o limite.
 * Retorna { allowed: boolean, remaining: number, resetIn: number (ms) }
 */
function check(key, { windowMs = 60_000, max = 20 } = {}) {
  const now  = Date.now();
  const cutoff = now - windowMs;

  let timestamps = (store.get(key) || []).filter(t => t > cutoff);

  if (timestamps.length >= max) {
    const oldest  = Math.min(...timestamps);
    const resetIn = oldest + windowMs - now;
    return { allowed: false, remaining: 0, resetIn };
  }

  timestamps.push(now);
  store.set(key, timestamps);
  return { allowed: true, remaining: max - timestamps.length, resetIn: 0 };
}

/**
 * Limites pré-configurados por contexto.
 */
const LIMITS = {
  // Mensagens recebidas no webhook — 30/min por telefone
  webhook: { windowMs: 60_000,      max: 30 },
  // Chamadas ao Gemini — 10/min por telefone (evita dreno de cota)
  gemini:  { windowMs: 60_000,      max: 10 },
  // Pedidos — 3 a cada 10 min por telefone (evita pedidos duplicados)
  order:   { windowMs: 10 * 60_000, max: 3  },
};

function checkWebhook(phone)  { return check(`wh:${phone}`,  LIMITS.webhook); }
function checkGemini(phone)   { return check(`gem:${phone}`, LIMITS.gemini);  }
function checkOrder(phone)    { return check(`ord:${phone}`, LIMITS.order);   }

module.exports = { check, checkWebhook, checkGemini, checkOrder, LIMITS };
