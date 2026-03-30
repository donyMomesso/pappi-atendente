const { Queue } = require("bullmq");
const { getRedis } = require("../lib/redis");
const cache = new Map();

function getQueue(name) {
  if (cache.has(name)) return cache.get(name);
  const connection = getRedis();
  if (!connection) return null;
  const queue = new Queue(name, { connection });
  cache.set(name, queue);
  return queue;
}

module.exports = { getQueue };
