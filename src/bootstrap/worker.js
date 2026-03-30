require('dotenv').config();

const logger = require('../lib/logger');
const { connectRedisIfConfigured } = require('../lib/redis');
const { startWorker } = require('../workers/enterprise.worker');

(async () => {
  try {
    await connectRedisIfConfigured();
    await startWorker();

    logger.info(
      { service: 'bootstrap-worker' },
      'Worker enterprise inicializado'
    );
  } catch (err) {
    logger.error(
      { service: 'bootstrap-worker', err },
      'Falha ao iniciar worker enterprise'
    );
    process.exit(1);
  }
})();