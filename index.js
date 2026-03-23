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

// Modo monólito: web + jobs + Baileys no mesmo processo (dev local).
// Produção: use start:web + start:baileys separados (evita 440).
console.log("  Iniciando serviços...");
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
  console.log("  ✅ Servidor pronto!");
  console.log(`  🔗 http://localhost:${PORT}`);
  console.log(`  📡 NODE_ENV=${ENV.NODE_ENV}`);
  console.log("");
});
