// src/bootstrap/jobs.js
// Inicializa apenas os schedulers (retention, cw-retry, order-delay, etc).
// Roda em processo separado ou junto com o web (modo monólito).

require("dotenv").config();
process.env.RUN_JOBS = "true";
process.env.RUN_BAILEYS = "false";

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
