require("dotenv").config();
const { connectRedisIfConfigured } = require("../lib/redis");
const { startWorker } = require("../workers/enterprise.worker");
const log = require("../lib/logger").child({ service: "bootstrap-worker" });

(async () => {
  await connectRedisIfConfigured();
  await startWorker();
  log.info("Worker enterprise inicializado");
})().catch((err) => { log.error({ err }, "Falha ao iniciar worker enterprise"); process.exit(1); });
