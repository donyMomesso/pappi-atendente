const { Worker } = require("bullmq");
const { getRedis } = require("../lib/redis");
const queueNames = require("../queues/names");
const log = require("../lib/logger").child({ service: "enterprise-worker" });

async function startWorker() {
  const connection = getRedis();
  if (!connection) { log.warn("REDIS_URL ausente; worker enterprise não iniciado."); return null; }
  const worker = new Worker(queueNames.inboundMessages, async (job) => { log.info({ jobId: job.id, name: job.name }, "Processando job inbound-messages"); return { ok: true }; }, { connection });
  worker.on("failed", (job, err) => log.error({ jobId: job?.id, err }, "Job falhou"));
  worker.on("completed", (job) => log.info({ jobId: job.id }, "Job concluído"));
  return worker;
}

module.exports = { startWorker };
