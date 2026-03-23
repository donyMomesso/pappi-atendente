// src/bootstrap/baileys.js
// Processo dedicado apenas ao Baileys (WhatsApp QR).
// Garante 1 único processo por sessão, evita 440.

require("dotenv").config();
process.env.RUN_JOBS = "false";
process.env.RUN_BAILEYS = "true";

console.log("\n  🍕 Pappi Atendente — processo Baileys\n");

const { validateEnv } = require("../lib/validate-env");
validateEnv();

const ENV = require("../config/env");
const log = require("../lib/logger").child({ service: "baileys-bootstrap" });

if (!ENV.BAILEYS_ENABLED) {
  log.warn("BAILEYS_ENABLED=false — processo encerrado");
  process.exit(0);
}

const prisma = require("../lib/db");

async function main() {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    log.error({ err }, "Banco indisponível — Baileys não iniciado");
    process.exit(1);
  }

  if (ENV.WEB_CONCURRENCY > 1) {
    log.warn(
      { WEB_CONCURRENCY: ENV.WEB_CONCURRENCY },
      "Baileys: WEB_CONCURRENCY>1 causa 440. Defina WEB_CONCURRENCY=1.",
    );
  }

  const baileys = require("../services/baileys.service");
  await baileys.initAll();

  log.info({ appEnv: ENV.APP_ENV, owner: require("../services/baileys-lock.service").ownerId() }, "Baileys iniciado em processo dedicado");

  // Mantém o processo vivo
  setInterval(() => {}, 60000);
}

main().catch((err) => {
  log.error({ err }, "Falha ao iniciar Baileys");
  process.exit(1);
});
