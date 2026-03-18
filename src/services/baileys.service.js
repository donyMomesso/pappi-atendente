// src/services/baileys.service.js
// WhatsApp via Baileys (QR Code) para notificações internas
// Não usa a API paga da Meta — conecta como WhatsApp Web

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");

const AUTH_DIR = path.join(__dirname, "../../.baileys-auth");
const STATE = {
  socket: null,
  qrBase64: null,        // QR code em base64 para exibir no painel
  status: "disconnected", // disconnected | qr | connecting | connected
  notifyTo: [],           // lista de números para notificações internas
};

async function start() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: require("pino")({ level: "silent" }),
    browser: ["Pappi Atendente", "Chrome", "1.0"],
  });

  STATE.socket = sock;
  STATE.status = "connecting";

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      STATE.status = "qr";
      STATE.qrBase64 = await QRCode.toDataURL(qr);
      console.log("[Baileys] QR Code gerado — acesse o painel para escanear");
    }

    if (connection === "open") {
      STATE.status = "connected";
      STATE.qrBase64 = null;
      console.log("[Baileys] WhatsApp conectado!");
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      STATE.status = "disconnected";
      STATE.socket = null;
      if (code !== DisconnectReason.loggedOut) {
        console.log("[Baileys] Reconectando...");
        setTimeout(start, 5000);
      } else {
        console.log("[Baileys] Desconectado (logout). Escaneie o QR novamente.");
        // Remove auth para forçar novo QR
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      }
    }
  });
}

/**
 * Envia mensagem de texto via Baileys.
 * @param {string} to  Número no formato 5511999999999 (sem +)
 * @param {string} text
 */
async function sendText(to, text) {
  if (!STATE.socket || STATE.status !== "connected") return false;
  try {
    const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
    await STATE.socket.sendMessage(jid, { text });
    return true;
  } catch (err) {
    console.error("[Baileys] Erro ao enviar:", err.message);
    return false;
  }
}

/**
 * Envia notificação para todos os números em STATE.notifyTo.
 */
async function notify(text) {
  if (!STATE.notifyTo.length) return;
  await Promise.all(STATE.notifyTo.map(n => sendText(n, text)));
}

function getStatus() {
  return { status: STATE.status, qr: STATE.qrBase64 };
}

function setNotifyNumbers(numbers) {
  STATE.notifyTo = Array.isArray(numbers) ? numbers : [];
}

function disconnect() {
  if (STATE.socket) STATE.socket.end();
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  STATE.status = "disconnected";
  STATE.socket = null;
  STATE.qrBase64 = null;
}

module.exports = { start, sendText, notify, getStatus, setNotifyNumbers, disconnect };
