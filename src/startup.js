// src/startup.js
// Baileys + jobs: chamado por index.js (monólito) ou por bootstrap/http.js (web sem Baileys).
// Produção recomendada hoje: index.js com RUN_BAILEYS=true e RUN_JOBS=true.

const ENV = require("./config/env");
const log = require("./lib/logger").child({ service: "startup" });

function schedule(name, delayMs, fn) {
  setTimeout(() => {
    try {
      fn();
      log.info({ name, delayMs }, "Startup: tarefa iniciada com atraso controlado");
    } catch (e) {
      log.warn({ err: e, name }, "[Startup] falha ao iniciar tarefa");
    }
  }, delayMs);
}

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
    const cwRetrySvc = require("./services/cw-retry.service");
    const orderDelayMonitor = require("./services/order-delay-monitor.service");
    const messageRetention = require("./services/message-retention.service");
    const aviseScheduler = require("./services/avise-abertura-scheduler");
    const handoffTimeout = require("./services/handoff-timeout-scheduler");

    schedule("retention", 250, () => retentionSvc.startScheduler());
    schedule("cw-retry", 1250, () => cwRetrySvc.startScheduler());
    schedule("order-delay", 2500, () => orderDelayMonitor.startScheduler());
    schedule("message-retention", 3750, () => messageRetention.startScheduler());
    schedule("avise-abertura", 5000, () => aviseScheduler.startScheduler());
    schedule("handoff-timeout", 6250, () => handoffTimeout.start());

    log.info("Jobs: agendados com startup escalonado (retention, cw-retry, order-delay, message-retention, avise-abertura, handoff-timeout)");
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
      appRuntime: ENV.APP_RUNTIME,
      webConcurrency: ENV.WEB_CONCURRENCY,
    },
    "Startup: monólito (index.js) — ordem Baileys + jobs",
  );
  startBaileys();
  startJobs();
}

module.exports = { runStartup, startBaileys, startJobs };
