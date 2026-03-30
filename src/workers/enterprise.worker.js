const { Worker } = require('bullmq');
const { getRedis } = require('../lib/redis');
const logger = require('../lib/logger');

let workerInstance = null;

async function startWorker() {
  if (workerInstance) return workerInstance;

  const connection = getRedis();

  workerInstance = new Worker(
    'enterprise',
    async (job) => {
      logger.info(
        {
          service: 'enterprise-worker',
          jobId: job.id,
          jobName: job.name,
        },
        'Processando job'
      );

      switch (job.name) {
        case 'ping':
          return { ok: true, pong: true };

        default:
          logger.warn(
            {
              service: 'enterprise-worker',
              jobId: job.id,
              jobName: job.name,
            },
            'Job sem handler específico'
          );
          return { ok: true, skipped: true, jobName: job.name };
      }
    },
    {
      connection,
      concurrency: 5,
    }
  );

  workerInstance.on('ready', () => {
    logger.info(
      { service: 'enterprise-worker' },
      'Worker enterprise pronto'
    );
  });

  workerInstance.on('completed', (job) => {
    logger.info(
      {
        service: 'enterprise-worker',
        jobId: job.id,
        jobName: job.name,
      },
      'Job concluído'
    );
  });

  workerInstance.on('failed', (job, err) => {
    logger.error(
      {
        service: 'enterprise-worker',
        jobId: job?.id,
        jobName: job?.name,
        err,
      },
      'Job falhou'
    );
  });

  workerInstance.on('error', (err) => {
    logger.error(
      {
        service: 'enterprise-worker',
        err,
      },
      'Erro no worker enterprise'
    );
  });

  return workerInstance;
}

module.exports = {
  startWorker,
};