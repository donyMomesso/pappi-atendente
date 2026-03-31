// src/bootstrap/jobs.js
// SECUNDÁRIO — só schedulers, sem HTTP. No monólito (npm start) os jobs já sobem com index.js.

require("dotenv").config();
process.env.RUN_JOBS = "true";
process.env.RUN_BAILEYS = "false";
process.env.APP_RUNTIME = process.env.APP_RUNTIME || "jobs";

console.log("\n  🍕 Pappi Atendente — processo Jobs\n");

const { validateEnv } = require("../lib/validate-env");
validateEnv();

const prisma = require("../lib/db");
const log = require("../lib/logger").child({ service: "jobs-bootstrap" });

async function startJobs() {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    log.error({ err }, "Banco indisponível — jobs não iniciados");
    process.exit(1);
  }

  const retentionSvc = require("../services/retention.service");
  const cwRetrySvc = require("../services/cw-retry.service");
  const orderDelayMonitor = require("../services/order-delay-monitor.service");
  const aviseScheduler = require("../services/avise-abertura-scheduler");
  const handoffTimeout = require("../services/handoff-timeout-scheduler");

  retentionSvc.startScheduler();
  cwRetrySvc.startScheduler();
  orderDelayMonitor.startScheduler();
  aviseScheduler.startScheduler();
  handoffTimeout.start();

  log.info("Schedulers iniciados: retention, cw-retry, order-delay, avise-abertura, handoff-timeout");

  // Mantém o processo vivo
  setInterval(() => {}, 60000);
}

startJobs().catch((err) => {
  log.error({ err }, "Falha ao iniciar jobs");
  process.exit(1);
});
