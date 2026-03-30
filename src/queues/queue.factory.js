const { Queue } = require('bullmq');
const { getRedis } = require('../lib/redis');

function makeQueue(name) {
  return new Queue(name, {
    connection: getRedis(),
  });
}

module.exports = {
  makeQueue,
};