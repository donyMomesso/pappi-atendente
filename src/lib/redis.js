const IORedis = require('ioredis');
const logger = require('./logger');

let redis = null;

function getRedis() {
  if (redis) return redis;

  if (!process.env.REDIS_URL) {
    throw new Error('REDIS_URL não configurada');
  }

  redis = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  redis.on('connect', () => {
    logger.info({ service: 'redis' }, 'Redis conectado');
  });

  redis.on('ready', () => {
    logger.info({ service: 'redis' }, 'Redis pronto');
  });

  redis.on('error', (err) => {
    logger.warn({ service: 'redis', err: err.message }, 'Redis error');
  });

  redis.on('close', () => {
    logger.warn({ service: 'redis' }, 'Conexão Redis fechada');
  });

  return redis;
}

async function connectRedisIfConfigured() {
  if (!process.env.REDIS_URL) {
    logger.warn({ service: 'redis' }, 'REDIS_URL ausente; Redis não será iniciado.');
    return null;
  }

  const client = getRedis();
  await client.ping();
  return client;
}

module.exports = {
  getRedis,
  connectRedisIfConfigured,
};