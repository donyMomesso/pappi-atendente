// src/services/socket.service.js

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

module.exports = { init, emitMessage, emitMessageStatus, emitConvUpdate, emitQueueUpdate, emitBaileysDisconnected, emitDelayAlert, getIO };
