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
  qrBase64: null,
  status: "disconnected", // disconnected | qr | connecting | connected
  notifyTo: [],
  starting: false,        // guard contra chamadas simultâneas
};

async function start() {
  // Evita múltiplas conexões simultâneas
  if (STATE.starting || STATE.status === "connected" || STATE.status === "qr") return;
  STATE.starting = true;

  try {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: require("pino")({ level: "silent" }),
      browser: ["Pappi Atendente", "Chrome", "1.0"],
      // Mantém QR válido por mais tempo
      qrTimeout: 60000,
    });

    STATE.socket = sock;
    STATE.status = "connecting";
    STATE.starting = false;

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
        STATE.starting = false;
        console.log("[Baileys] WhatsApp conectado!");
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        STATE.status = "disconnected";
        STATE.socket = null;
        STATE.starting = false;

        if (loggedOut) {
          console.log("[Baileys] Logout — limpa auth e aguarda reconexão manual.");
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          STATE.qrBase64 = null;
        } else {
          console.log(`[Baileys] Conexão fechada (code=${code}) — reconectando em 8s...`);
          setTimeout(start, 8000);
        }
      }
    });
  } catch (err) {
    STATE.starting = false;
    console.error("[Baileys] Erro ao iniciar:", err.message);
    setTimeout(start, 15000);
  }
}

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
  STATE.starting = false;
  if (STATE.socket) { try { STATE.socket.end(); } catch(e) {} }
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch(e) {}
  STATE.status = "disconnected";
  STATE.socket = null;
  STATE.qrBase64 = null;
}

module.exports = { start, sendText, notify, getStatus, setNotifyNumbers, disconnect };
