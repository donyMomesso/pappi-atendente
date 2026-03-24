// src/bootstrap/http.js
// SECUNDÁRIO — não use como deploy principal hoje.
// Produção recomendada: npm start (index.js) = monólito com Baileys + jobs + Socket.IO junto.
// Este arquivo força RUN_BAILEYS=false; jobs ainda sobem (útil só em arquitetura split legada).

require("dotenv").config();
process.env.RUN_BAILEYS = "false";

console.log("\n  🍕 Pappi — bootstrap Web (sem Baileys neste processo) — prefira `npm start` para monólito\n");

const { validateEnv } = require("../lib/validate-env");
validateEnv();

const http = require("http");
const app = require("../app");
const socketService = require("../services/socket.service");
const { runStartup } = require("../startup");
const ENV = require("../config/env");
const messageDbCompat = require("../lib/message-db-compat");

const PORT = ENV.PORT || 10000;

const server = http.createServer(app);
socketService.init(server);

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n❌ Porta ${PORT} em uso.\n`);
  } else {
    console.error("Erro no servidor:", err);
  }
  process.exit(1);
});

(async function boot() {
  try {
    await messageDbCompat.refreshMessageSenderEmailSupport();
  } catch (e) {
    console.warn("  [message-db-compat]", e.message);
  }
  runStartup();
  server.listen(PORT, () => {
    console.log("");
    console.log("  🍕 Pappi Web/API pronto");
    console.log(`  🔗 http://localhost:${PORT} (NODE_ENV=${ENV.NODE_ENV})`);
    console.log("");
  });
})();
