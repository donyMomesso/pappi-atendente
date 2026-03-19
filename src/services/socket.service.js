// src/services/socket.service.js
// Gerencia o servidor WebSocket (socket.io)
// Permite push em tempo real para o painel de atendimento

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

/**
 * Emite nova mensagem para todos os clientes conectados ao painel
 * @param {string} customerId
 * @param {object} message - { role, text, sender, mediaUrl, mediaType, at, status }
 */
function emitMessage(customerId, message) {
  if (!_io) return;
  _io.emit("new_message", { customerId, message });
}

/**
 * Emite atualização de status de conversa (handoff, nova conversa, etc.)
 */
function emitConvUpdate(customerId, data) {
  if (!_io) return;
  _io.emit("conv_update", { customerId, ...data });
}

/**
 * Emite notificação de novo cliente na fila
 */
function emitQueueUpdate() {
  if (!_io) return;
  _io.emit("queue_update");
}

function getIO() { return _io; }

module.exports = { init, emitMessage, emitConvUpdate, emitQueueUpdate, getIO };
