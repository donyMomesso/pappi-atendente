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
const messageDbCompat = require("./src/lib/message-db-compat");
const orderPixDbCompat = require("./src/lib/order-pix-db-compat");

const PORT = Number(ENV.PORT) || 10000;
/** Render / Docker exigem bind em todas as interfaces; não bloquear listen com await ao DB (evita port scan timeout). */
const BIND_HOST = process.env.BIND_HOST || "0.0.0.0";

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

// Ordem monólito: Socket.IO antes de runStartup() — Baileys usa getIO() e emite eventos ao painel.
const server = http.createServer(app);
socketService.init(server);
console.log("  Socket.IO anexado ao servidor HTTP");
console.log("  Abrindo porta (sondagem DB + Baileys + jobs após listen — compatível com Render)...");

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n❌ Porta ${PORT} em uso. Feche o outro processo ou altere PORT no .env`);
    console.error(`   Windows: netstat -ano | findstr :${PORT}\n`);
  } else {
    console.error("Erro no servidor:", err);
  }
  process.exit(1);
});

server.listen(PORT, BIND_HOST, () => {
  console.log("");
  console.log("  ✅ Monólito no ar — escutando HTTP + WebSocket");
  console.log(`  🔗 http://${BIND_HOST}:${PORT} (NODE_ENV=${ENV.NODE_ENV})`);
  console.log("");
  (async function postListenInit() {
    try {
      await messageDbCompat.refreshMessageSenderEmailSupport();
    } catch (e) {
      console.warn("  [message-db-compat] falha ao sondar public.messages:", e.message);
    }
    try {
      await orderPixDbCompat.refreshOrderPixColumnSupport();
    } catch (e) {
      console.warn("  [order-pix-db-compat] falha ao sondar orders PIX:", e.message);
    }
    runStartup();
  })();
});
