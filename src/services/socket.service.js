// src/services/socket.service.js
//
// Coexistência multi-canal:
// - Cloud API, Meta (IG/FB) e rotas /dash disparam eventos daqui quando Socket.IO foi init() no MESMO processo.
// - Se Baileys (ou jobs) rodam em processo separado (start:baileys / start:jobs), _io fica null aqui:
//   mensagens ainda vão ao banco via chatMemory, mas o painel só atualiza no polling (~10s) ou com Redis adapter.
// - Recomendação: produção simples = um processo (npm start / node index.js) ou @socket.io/redis-adapter entre web e workers.

let _io = null;

function init(server) {
  const { Server } = require("socket.io");
  _io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ["websocket", "polling"],
  });

  _io.on("connection", (socket) => {
    console.log(`[Socket] Cliente conectado: ${socket.id}`);
    socket.on("disconnect", () => {
      console.log(`[Socket] Cliente desconectado: ${socket.id}`);
    });
  });

  console.log("[Socket] WebSocket server iniciado");
  return _io;
}

function emitMessage(customerId, message) {
  if (!_io) return;
  _io.emit("new_message", { customerId, message });
}

// NOVO: propaga status do check azul (sent/delivered/read/failed) para o painel
function emitMessageStatus(customerId, waMessageId, status) {
  if (!_io) return;
  _io.emit("message_status", { customerId, waMessageId, status });
}

function emitConvUpdate(customerId, data) {
  if (!_io) return;
  _io.emit("conv_update", { customerId, ...data });
}

function emitQueueUpdate() {
  if (!_io) return;
  _io.emit("queue_update");
}

function emitBaileysDisconnected(instanceId, reason) {
  if (!_io) return;
  _io.emit("baileys_disconnected", { instanceId, reason });
}

function emitDelayAlert(tenantId, payload) {
  if (!_io) return;
  _io.emit("delay_alert", { tenantId, ...payload });
}

function getIO() {
  return _io;
}

function emitAlert(alert) {
  if (!_io) return;
  _io.emit("alert", alert);
}

module.exports = {
  init,
  emitMessage,
  emitMessageStatus,
  emitConvUpdate,
  emitQueueUpdate,
  emitBaileysDisconnected,
  emitDelayAlert,
  emitAlert,
  getIO,
};
