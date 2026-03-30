const IORedis = require("ioredis");
const ENV = require("../config/env");
const log = require("./logger").child({ service: "redis" });

let client = null;

function getRedis() {
  if (!ENV.REDIS_URL) return null;
  if (client) return client;
  client = new IORedis(ENV.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
  client.on("error", (err) => log.warn({ err: err.message }, "Redis error"));
  client.on("connect", () => log.info("Redis conectado"));
  return client;
}

async function connectRedisIfConfigured() {
  const redis = getRedis();
  if (!redis) return null;
  if (redis.status === "ready" || redis.status === "connect") return redis;
  await redis.connect().catch((err) => { log.warn({ err: err.message }, "Falha ao conectar no Redis"); });
  return redis;
}

module.exports = { getRedis, connectRedisIfConfigured };
