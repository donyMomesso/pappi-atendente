const { getRedis } = require("../lib/redis");
const log = require("../lib/logger").child({ service: "idempotency" });
const memory = new Map();
const DEFAULT_TTL_SEC = 60 * 30;

function cleanupMemory() { const now = Date.now(); for (const [key, expiresAt] of memory.entries()) if (expiresAt <= now) memory.delete(key); }

async function claimOnce(key, ttlSec = DEFAULT_TTL_SEC) {
  if (!key) return true;
  const redis = getRedis();
  if (redis) {
    try { const result = await redis.set(key, "1", "EX", ttlSec, "NX"); return result === "OK"; }
    catch (err) { log.warn({ err: err.message, key }, "Redis indisponível para idempotência; usando memória local"); }
  }
  cleanupMemory();
  if (memory.has(key)) return false;
  memory.set(key, Date.now() + ttlSec * 1000);
  return true;
}

module.exports = { claimOnce };
