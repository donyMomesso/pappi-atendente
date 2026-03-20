// src/lib/retry.js

async function withRetry(fn, opts = {}) {
  const {
    maxAttempts = 3,
    baseDelayMs = 500,
    maxDelayMs = 15000,
    jitter = 0.2,
    shouldRetry = defaultShouldRetry,
    label = "retry",
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
      console.warn(`[${label}] Tentativa ${attempt}/${maxAttempts} falhou (${err.message}). Aguardando ${delay}ms...`);
      await sleep(delay);
    }
  }
  throw lastError;
}

function retry(fn, maxAttempts = 3, label = "retry") {
  return withRetry(fn, { maxAttempts, label });
}

function calcDelay(attempt, base, max, jitter) {
  const exp = base * Math.pow(2, attempt - 1);
  const capped = Math.min(exp, max);
  const factor = 1 + (Math.random() * 2 - 1) * jitter;
  return Math.round(capped * factor);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultShouldRetry(err, _attempt) {
  const status = err.status || err.statusCode || err.response?.status;
  if (!status) return true;
  if (status === 429) return true;
  if (status === 408) return true;
  if (status >= 500) return true;
  return false;
}

module.exports = { withRetry, retry };
