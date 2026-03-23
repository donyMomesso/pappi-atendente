// src/startup.js
// Inicialização condicional de Baileys e Jobs.
// Chamado pelo index.js (modo monólito). Ignorado pelo bootstrap/http.js (processo web isolado).

const ENV = require("./config/env");
const log = require("./lib/logger").child({ service: "startup" });

function startBaileys() {
  if (!ENV.BAILEYS_ENABLED) return;
  try {
    const baileys = require("./services/baileys.service");
    baileys.initAll().catch((e) => log.warn({ err: e }, "[Baileys] initAll error"));
  } catch (e) {
    log.warn({ err: e }, "[Baileys] módulo não disponível");
  }
}

function startJobs() {
  try {
    const retentionSvc = require("./services/retention.service");
    retentionSvc.startScheduler();
    const cwRetrySvc = require("./services/cw-retry.service");
    cwRetrySvc.startScheduler();
    const orderDelayMonitor = require("./services/order-delay-monitor.service");
    orderDelayMonitor.startScheduler();
    const aviseScheduler = require("./services/avise-abertura-scheduler");
    aviseScheduler.startScheduler();
    const handoffTimeout = require("./services/handoff-timeout-scheduler");
    handoffTimeout.start();
  } catch (e) {
    log.warn({ err: e }, "[Startup] scheduler error");
  }
}

function runStartup() {
  if (ENV.RUN_BAILEYS) startBaileys();
  if (ENV.RUN_JOBS) startJobs();
}

module.exports = { runStartup, startBaileys, startJobs };
