// src/services/baileys.service.js
// WhatsApp via Baileys (QR Code) para notificações INTERNAS da equipe
//
// ╔══════════════════════════════════════════════════════════════╗
// ║  REGRAS DE USO — LEIA ANTES DE ALTERAR                      ║
// ║                                                              ║
// ║  1. Este número é EXCLUSIVO para notificações internas.      ║
// ║     Nunca envie mensagens para clientes por aqui.            ║
// ║                                                              ║
// ║  2. Apenas números cadastrados em STATE.notifyTo podem       ║
// ║     receber mensagens (equipe interna).                      ║
// ║                                                              ║
// ║  3. Limites de segurança (para não ser banido pelo Meta):    ║
// ║     • Máx 20 mensagens por hora                             ║
// ║     • Máx 80 mensagens por dia                              ║
// ║     • Alerta em 70% do limite (14/hora ou 56/dia)           ║
// ║     • Bloqueio automático ao atingir 100%                   ║
// ║                                                              ║
// ║  4. Baileys é não-oficial. Não automatize em massa.         ║
// ║     Use apenas para alertas pontuais da operação.           ║
// ╚══════════════════════════════════════════════════════════════╝

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { useDbAuthState, clearDbAuth } = require("./baileys-db-auth");
const QRCode = require("qrcode");

// ── Limites de segurança ───────────────────────────────────────
const LIMITS = {
  perHour:    20,
  perDay:     80,
  alertAt:    0.7,   // alerta em 70% do limite
};

const COUNTERS = {
  hour:      0,
  day:       0,
  hourReset: Date.now() + 3600_000,
  dayReset:  Date.now() + 86_400_000,
  alerted:   { hour: false, day: false },
};

function resetCountersIfNeeded() {
  const now = Date.now();
  if (now >= COUNTERS.hourReset) {
    COUNTERS.hour = 0;
    COUNTERS.hourReset = now + 3600_000;
    COUNTERS.alerted.hour = false;
  }
  if (now >= COUNTERS.dayReset) {
    COUNTERS.day = 0;
    COUNTERS.dayReset = now + 86_400_000;
    COUNTERS.alerted.day = false;
  }
}

function checkLimits() {
  resetCountersIfNeeded();

  const hourPct = COUNTERS.hour / LIMITS.perHour;
  const dayPct  = COUNTERS.day  / LIMITS.perDay;

  // Alerta em 70%
  if (hourPct >= LIMITS.alertAt && !COUNTERS.alerted.hour) {
    COUNTERS.alerted.hour = true;
    const msg = `⚠️ [Baileys] Atenção: ${COUNTERS.hour}/${LIMITS.perHour} msgs na última hora (${Math.round(hourPct*100)}%). Reduza o uso para evitar bloqueio.`;
    console.warn(msg);
    STATE.lastAlert = msg;
  }
  if (dayPct >= LIMITS.alertAt && !COUNTERS.alerted.day) {
    COUNTERS.alerted.day = true;
    const msg = `⚠️ [Baileys] Atenção: ${COUNTERS.day}/${LIMITS.perDay} msgs hoje (${Math.round(dayPct*100)}%). Reduza o uso para evitar bloqueio.`;
    console.warn(msg);
    STATE.lastAlert = msg;
  }

  // Bloqueio
  if (COUNTERS.hour >= LIMITS.perHour) {
    const msg = `🚫 [Baileys] Limite HORÁRIO atingido (${LIMITS.perHour}/h). Mensagem bloqueada automaticamente.`;
    console.error(msg);
    STATE.lastAlert = msg;
    return false;
  }
  if (COUNTERS.day >= LIMITS.perDay) {
    const msg = `🚫 [Baileys] Limite DIÁRIO atingido (${LIMITS.perDay}/dia). Mensagem bloqueada automaticamente.`;
    console.error(msg);
    STATE.lastAlert = msg;
    return false;
  }

  return true;
}

// ── Estado global ──────────────────────────────────────────────
const STATE = {
  socket:    null,
  qrBase64:  null,
  status:    "disconnected",
  notifyTo:  [],
  starting:  false,
  lastAlert: null,
};

// ── Conexão ────────────────────────────────────────────────────
async function start() {
  if (STATE.starting || STATE.status === "connected" || STATE.status === "qr") return;
  STATE.starting = true;

  try {
    const { state, saveCreds } = await useDbAuthState();
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: require("pino")({ level: "silent" }),
      browser: ["Pappi Atendente", "Chrome", "1.0"],
      qrTimeout: 60000,
    });

    STATE.socket   = sock;
    STATE.status   = "connecting";
    STATE.starting = false;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        STATE.status   = "qr";
        STATE.qrBase64 = await QRCode.toDataURL(qr);
        console.log("[Baileys] QR Code gerado — acesse o painel para escanear");
      }

      if (connection === "open") {
        STATE.status   = "connected";
        STATE.qrBase64 = null;
        STATE.starting = false;
        console.log("[Baileys] WhatsApp conectado!");
      }

      if (connection === "close") {
        const code      = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        STATE.status   = "disconnected";
        STATE.socket   = null;
        STATE.starting = false;

        if (loggedOut) {
          console.log("[Baileys] Logout — limpa auth no banco e aguarda reconexão manual.");
          await clearDbAuth();
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

// ── Envio protegido ────────────────────────────────────────────
async function sendText(to, text) {
  if (!STATE.socket || STATE.status !== "connected") return false;

  // Só envia para números internos cadastrados
  if (!STATE.notifyTo.includes(to)) {
    console.warn(`[Baileys] Envio bloqueado para ${to} — número não está na lista interna.`);
    return false;
  }

  // Verifica limites
  if (!checkLimits()) return false;

  try {
    const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
    await STATE.socket.sendMessage(jid, { text });
    COUNTERS.hour++;
    COUNTERS.day++;
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
  resetCountersIfNeeded();
  return {
    status:    STATE.status,
    qr:        STATE.qrBase64,
    lastAlert: STATE.lastAlert,
    usage: {
      hour:    COUNTERS.hour,
      hourMax: LIMITS.perHour,
      day:     COUNTERS.day,
      dayMax:  LIMITS.perDay,
    },
  };
}

function setNotifyNumbers(numbers) {
  STATE.notifyTo = Array.isArray(numbers) ? numbers : [];
}

function disconnect() {
  STATE.starting = false;
  if (STATE.socket) { try { STATE.socket.end(); } catch(e) {} }
  clearDbAuth().catch(()=>{});
  STATE.status   = "disconnected";
  STATE.socket   = null;
  STATE.qrBase64 = null;
}

module.exports = { start, sendText, notify, getStatus, setNotifyNumbers, disconnect };
