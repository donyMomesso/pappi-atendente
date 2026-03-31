// src/bootstrap/http.js
// SECUNDÁRIO — não use como deploy principal hoje.
// Produção recomendada: npm start (index.js) = monólito com Baileys + jobs + Socket.IO junto.
// Este arquivo força RUN_BAILEYS=false; jobs ainda sobem (útil só em arquitetura split legada).

require("dotenv").config();
process.env.RUN_BAILEYS = "false";
process.env.APP_RUNTIME = process.env.APP_RUNTIME || "web";

console.log("\n  🍕 Pappi — bootstrap Web (sem Baileys neste processo) — prefira `npm start` para monólito\n");

const { validateEnv } = require("../lib/validate-env");
validateEnv();

const http = require("http");
const app = require("../app");
const socketService = require("../services/socket.service");
const { runStartup } = require("../startup");
const ENV = require("../config/env");
const messageDbCompat = require("../lib/message-db-compat");
const orderPixDbCompat = require("../lib/order-pix-db-compat");

const PORT = Number(ENV.PORT) || 10000;
const BIND_HOST = process.env.BIND_HOST || "0.0.0.0";

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

server.listen(PORT, BIND_HOST, () => {
  console.log("");
  console.log("  🍕 Pappi Web/API pronto");
  console.log(`  🔗 http://${BIND_HOST}:${PORT} (NODE_ENV=${ENV.NODE_ENV})`);
  console.log("");
  (async function postListenInit() {
    try {
      await messageDbCompat.refreshMessageSenderEmailSupport();
    } catch (e) {
      console.warn("  [message-db-compat]", e.message);
    }
    try {
      await orderPixDbCompat.refreshOrderPixColumnSupport();
    } catch (e) {
      console.warn("  [order-pix-db-compat]", e.message);
    }
    runStartup();
  })();
});
