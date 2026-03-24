require("dotenv").config();

// ── Saudação de boot ─────────────────────────────────────────────────────
console.log("");
console.log("  ╔═══════════════════════════════════════════════════════════╗");
console.log("  ║           🍕 Pappi Atendente v3.1.0                       ║");
console.log("  ║           Sistema de atendimento WhatsApp + IA            ║");
console.log("  ╚═══════════════════════════════════════════════════════════╝");
console.log("");

const { validateEnv } = require("./src/lib/validate-env");
validateEnv();

const ENV = require("./src/config/env");
const http = require("http");
const app = require("./src/app");
const socketService = require("./src/services/socket.service");
const { runStartup } = require("./src/startup");

const PORT = ENV.PORT || 10000;

console.log("  ┌─ Modo MONÓLITO (produção recomendada hoje) ──────────────┐");
console.log("  │  HTTP + Socket.IO + schedulers + Baileys → mesmo processo │");
console.log("  └────────────────────────────────────────────────────────────┘");
console.log(`  NODE_ENV=${ENV.NODE_ENV}  RUN_BAILEYS=${ENV.RUN_BAILEYS}  RUN_JOBS=${ENV.RUN_JOBS}`);
console.log(`  BAILEYS_ENABLED=${ENV.BAILEYS_ENABLED}  WEB_CONCURRENCY=${ENV.WEB_CONCURRENCY}`);
if (ENV.WEB_CONCURRENCY > 1) {
  console.warn("  ⚠️  WEB_CONCURRENCY>1 pode causar erro 440 no WhatsApp QR — use 1 neste serviço.");
}
if (ENV.NODE_ENV === "production" && (!ENV.RUN_BAILEYS || !ENV.RUN_JOBS)) {
  console.warn("  ⚠️  RUN_BAILEYS ou RUN_JOBS desligados — confirme se é intencional para este deploy.");
}
console.log("  Iniciando serviços (startup)...");
runStartup();

const server = http.createServer(app);
socketService.init(server);

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n❌ Porta ${PORT} em uso. Feche o outro processo ou altere PORT no .env`);
    console.error(`   Windows: netstat -ano | findstr :${PORT}\n`);
  } else {
    console.error("Erro no servidor:", err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log("");
  console.log("  ✅ Monólito no ar — escutando HTTP + WebSocket");
  console.log(`  🔗 porta ${PORT} (NODE_ENV=${ENV.NODE_ENV})`);
  console.log("");
});
