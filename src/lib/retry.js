// src/lib/retry.js
// Req 8 — Retry com exponential backoff

/**
 * Executa uma função assíncrona com retry e backoff exponencial.
 *
 * @param {Function} fn           Função async a ser executada
 * @param {object}   [opts]
 * @param {number}   [opts.maxAttempts=3]    Número máximo de tentativas
 * @param {number}   [opts.baseDelayMs=500]  Delay base em ms
 * @param {number}   [opts.maxDelayMs=15000] Delay máximo em ms
 * @param {number}   [opts.jitter=0.2]       Fator de jitter (0–1)
 * @param {Function} [opts.shouldRetry]      (error, attempt) → boolean
 * @param {string}   [opts.label]            Identificador para logs
 * @returns {Promise<any>}
 * @throws  Lança o último erro se todas as tentativas falharem
 */
async function withRetry(fn, opts = {}) {
  const {
    maxAttempts = 3,
    baseDelayMs = 500,
    maxDelayMs  = 15000,
    jitter      = 0.2,
    shouldRetry = defaultShouldRetry,
    label       = "retry",
  } = opts;

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      const isLast = attempt === maxAttempts;
      const doRetry = !isLast && shouldRetry(err, attempt);

      if (!doRetry) {
        console.error(`[${label}] Falhou definitivamente na tentativa ${attempt}:`, err.message);
        throw err;
      }

      const delay = calcDelay(attempt, baseDelayMs, maxDelayMs, jitter);
      console.warn(
        `[${label}] Tentativa ${attempt}/${maxAttempts} falhou (${err.message}). Aguardando ${delay}ms...`
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Versão simplificada: tenta N vezes sem configuração extra.
 *
 * @param {Function} fn
 * @param {number}   maxAttempts
 * @param {string}   [label]
 */
function retry(fn, maxAttempts = 3, label = "retry") {
  return withRetry(fn, { maxAttempts, label });
}

// ── Helpers ─────────────────────────────────────────────────

function calcDelay(attempt, base, max, jitter) {
  // Exponential: base * 2^(attempt-1)
  const exp = base * Math.pow(2, attempt - 1);
  const capped = Math.min(exp, max);
  // Jitter aleatório ±jitter%
  const factor = 1 + (Math.random() * 2 - 1) * jitter;
  return Math.round(capped * factor);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Por padrão, não retentar em erros 4xx (exceto 429 e 408).
 * Sempre retentar em 5xx, timeouts e erros de rede.
 */
function defaultShouldRetry(err, _attempt) {
  const status = err.status || err.statusCode || err.response?.status;

  // Erros sem status (rede, timeout) → retry
  if (!status) return true;

  // 429 Too Many Requests → retry
  if (status === 429) return true;

  // 408 Request Timeout → retry
  if (status === 408) return true;

  // 5xx Server Errors → retry
  if (status >= 500) return true;

  // 4xx Client Errors → não retentar
  return false;
}

module.exports = { withRetry, retry };
