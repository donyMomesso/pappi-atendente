// src/bootstrap/http.js
// Inicializa apenas o servidor HTTP + Socket.io.
// Usado quando processos são separados (web, jobs, baileys).
// NÃO inicia Baileys nem Jobs.

require("dotenv").config();
process.env.RUN_JOBS = "false";
process.env.RUN_BAILEYS = "false";
const { validateEnv } = require("../lib/validate-env");
validateEnv();

const http = require("http");
const app = require("../app");
const socketService = require("../services/socket.service");
const ENV = require("../config/env");

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
  console.log(`🔥 Pappi Web/API rodando na porta ${PORT} (NODE_ENV=${ENV.NODE_ENV})`);
});
