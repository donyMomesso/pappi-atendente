// src/startup.js
// Baileys + jobs: chamado por index.js (monólito) ou por bootstrap/http.js (web sem Baileys).
// Produção recomendada hoje: index.js com RUN_BAILEYS=true e RUN_JOBS=true.

const ENV = require("./config/env");
const log = require("./lib/logger").child({ service: "startup" });

function startBaileys() {
  if (!ENV.RUN_BAILEYS) {
    log.info("Baileys: desligado (RUN_BAILEYS=false)");
    return;
  }
  if (!ENV.BAILEYS_ENABLED) {
    log.info("Baileys: desligado (BAILEYS_ENABLED=false)");
    return;
  }
  try {
    const baileys = require("./services/baileys.service");
    log.info({ WEB_CONCURRENCY: ENV.WEB_CONCURRENCY }, "Baileys: iniciando initAll (monólito)");
    baileys.initAll().catch((e) => log.warn({ err: e }, "[Baileys] initAll error"));
  } catch (e) {
    log.warn({ err: e }, "[Baileys] módulo não disponível");
  }
}

function startJobs() {
  if (!ENV.RUN_JOBS) {
    log.info("Jobs: desligados (RUN_JOBS=false)");
    return;
  }
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
    log.info("Jobs: schedulers ativos (retention, cw-retry, order-delay, avise-abertura, handoff-timeout)");
  } catch (e) {
    log.warn({ err: e }, "[Startup] scheduler error");
  }
}

function runStartup() {
  if (ENV.WEB_CONCURRENCY > 1) {
    log.warn(
      { WEB_CONCURRENCY: ENV.WEB_CONCURRENCY },
      "WEB_CONCURRENCY>1 — risco de sessão Baileys 440; em produção monolítica use 1",
    );
  }
  log.info(
    {
      runBaileys: ENV.RUN_BAILEYS,
      runJobs: ENV.RUN_JOBS,
      baileysEnabled: ENV.BAILEYS_ENABLED,
      webConcurrency: ENV.WEB_CONCURRENCY,
    },
    "Startup: monólito (index.js) — ordem Baileys + jobs",
  );
  startBaileys();
  startJobs();
}

module.exports = { runStartup, startBaileys, startJobs };
