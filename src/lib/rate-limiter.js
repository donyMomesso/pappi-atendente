// src/lib/rate-limiter.js
// Rate limiting por telefone com sliding window em memória.
// Protege contra spam, dreno de cota Gemini e flood de pedidos.

// windowMs → tamanho da janela em ms
// max      → máximo de eventos na janela
// store    → Map de phone → [timestamps]

const store = new Map();

// Limpeza periódica de entradas expiradas (evita memory leak)
const cleanupInterval = setInterval(
  () => {
    const cutoff = Date.now() - 5 * 60 * 1000; // remove entradas > 5 min
    for (const [key, timestamps] of store.entries()) {
      const fresh = timestamps.filter((t) => t > cutoff);
      if (fresh.length === 0) store.delete(key);
      else store.set(key, fresh);
    }
  },
  2 * 60 * 1000,
);

/** Para testes: encerra o setInterval para Jest sair sem open handle */
function stopCleanup() {
  if (cleanupInterval) clearInterval(cleanupInterval);
}

/**
 * Verifica se a chave ultrapassou o limite.
 * Retorna { allowed: boolean, remaining: number, resetIn: number (ms) }
 */
function check(key, { windowMs = 60_000, max = 20 } = {}) {
  const now = Date.now();
  const cutoff = now - windowMs;

  let timestamps = (store.get(key) || []).filter((t) => t > cutoff);

  if (timestamps.length >= max) {
    const oldest = Math.min(...timestamps);
    const resetIn = oldest + windowMs - now;
    return { allowed: false, remaining: 0, resetIn };
  }

  timestamps.push(now);
  store.set(key, timestamps);
  return { allowed: true, remaining: max - timestamps.length, resetIn: 0 };
}

// Limites via env (ex: RATE_LIMIT_WEBHOOK_MAX=60) ou padrão
function limitFromEnv(envKey, defaultMax) {
  const n = parseInt(process.env[envKey], 10);
  return isNaN(n) ? defaultMax : Math.max(5, n);
}

const LIMITS = {
  webhook: { windowMs: 60_000, max: limitFromEnv("RATE_LIMIT_WEBHOOK_MAX", 60) },
  gemini: { windowMs: 60_000, max: limitFromEnv("RATE_LIMIT_GEMINI_MAX", 15) },
  order: { windowMs: 10 * 60_000, max: limitFromEnv("RATE_LIMIT_ORDER_MAX", 5) },
};

function checkWebhook(phone) {
  return check(`wh:${phone}`, LIMITS.webhook);
}
function checkGemini(phone) {
  return check(`gem:${phone}`, LIMITS.gemini);
}
function checkOrder(phone) {
  return check(`ord:${phone}`, LIMITS.order);
}

module.exports = { check, checkWebhook, checkGemini, checkOrder, LIMITS, stopCleanup };
