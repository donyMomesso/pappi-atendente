// src/bootstrap/http.js
// Inicializa servidor HTTP + Socket.io + Jobs.
// NÃO inicia Baileys — processo dedicado em src/bootstrap/baileys.js.

require("dotenv").config();
process.env.RUN_BAILEYS = "false";

console.log("\n  🍕 Pappi Atendente — processo Web/API\n");

const { validateEnv } = require("../lib/validate-env");
validateEnv();

const http = require("http");
const app = require("../app");
const socketService = require("../services/socket.service");
const { runStartup } = require("../startup");
const ENV = require("../config/env");

runStartup();

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

server.listen(PORT, () => {
  console.log("");
  console.log("  🍕 Pappi Web/API pronto");
  console.log(`  🔗 http://localhost:${PORT} (NODE_ENV=${ENV.NODE_ENV})`);
  console.log("");
});
