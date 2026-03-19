// src/services/baileys.service.js
// Multi-WhatsApp via Baileys (QR Code) para notificações INTERNAS da equipe

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { useDbAuthState, clearDbAuth, listInstances } = require("./baileys-db-auth");
const QRCode = require("qrcode");

// ── Limites de segurança por instância ──────────────────────────
const LIMITS = {
  perHour:    20,
  perDay:     80,
  alertAt:    0.7,
};

// Mapa de instâncias: { [instanceId]: { socket, status, qr, account, counters, ... } }
const INSTANCES = new Map();

function createInstanceData(id) {
  return {
    id,
    socket:    null,
    qrBase64:  null,
    status:    "disconnected",
    starting:  false,
    lastAlert: null,
    account:   null,
    notifyTo:  [],
    counters: {
      hour:      0,
      day:       0,
      hourReset: Date.now() + 3600_000,
      dayReset:  Date.now() + 86_400_000,
      alerted:   { hour: false, day: false },
    }
  };
}

function resetCounters(inst) {
  const now = Date.now();
  if (now >= inst.counters.hourReset) {
    inst.counters.hour = 0;
    inst.counters.hourReset = now + 3600_000;
    inst.counters.alerted.hour = false;
  }
  if (now >= inst.counters.dayReset) {
    inst.counters.day = 0;
    inst.counters.dayReset = now + 86_400_000;
    inst.counters.alerted.day = false;
  }
}

function checkLimits(inst) {
  resetCounters(inst);
  const hourPct = inst.counters.hour / LIMITS.perHour;
  const dayPct  = inst.counters.day  / LIMITS.perDay;

  if (hourPct >= LIMITS.alertAt && !inst.counters.alerted.hour) {
    inst.counters.alerted.hour = true;
    inst.lastAlert = `⚠️ [${inst.id}] Atenção: ${inst.counters.hour}/${LIMITS.perHour} msgs/h (${Math.round(hourPct*100)}%).`;
  }
  if (dayPct >= LIMITS.alertAt && !inst.counters.alerted.day) {
    inst.counters.alerted.day = true;
    inst.lastAlert = `⚠️ [${inst.id}] Atenção: ${inst.counters.day}/${LIMITS.perDay} msgs/dia (${Math.round(dayPct*100)}%).`;
  }

  if (inst.counters.hour >= LIMITS.perHour) {
    inst.lastAlert = `🚫 [${inst.id}] Limite HORÁRIO atingido (${LIMITS.perHour}/h).`;
    return false;
  }
  if (inst.counters.day >= LIMITS.perDay) {
    inst.lastAlert = `🚫 [${inst.id}] Limite DIÁRIO atingido (${LIMITS.perDay}/dia).`;
    return false;
  }
  return true;
}

// ── Conexão ────────────────────────────────────────────────────
async function start(instanceId = "default") {
  let inst = INSTANCES.get(instanceId);
  if (!inst) {
    inst = createInstanceData(instanceId);
    INSTANCES.set(instanceId, inst);
  }

  if (inst.starting || inst.status === "connected" || inst.status === "qr") return;
  inst.starting = true;

  try {
    const { state, saveCreds } = await useDbAuthState(instanceId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: require("pino")({ level: "silent" }),
      browser: ["Pappi Atendente", "Chrome", "1.0"],
      qrTimeout: 60000,
    });

    inst.socket   = sock;
    inst.status   = "connecting";
    inst.starting = false;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        inst.status   = "qr";
        inst.qrBase64 = await QRCode.toDataURL(qr);
        console.log(`[Baileys:${instanceId}] QR Code gerado`);
      }

      if (connection === "open") {
        inst.status   = "connected";
        inst.qrBase64 = null;
        inst.starting = false;
        const user = sock.user;
        inst.account = {
          phone: user?.id?.split(":")[0] || user?.id || "?",
          name:  user?.name || "?",
        };
        console.log(`[Baileys:${instanceId}] Conectado como ${inst.account.name} (${inst.account.phone})`);
      }

      if (connection === "close") {
        const code      = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        inst.status   = "disconnected";
        inst.socket   = null;
        inst.starting = false;

        if (loggedOut) {
          console.log(`[Baileys:${instanceId}] Logout — limpando auth.`);
          await clearDbAuth(instanceId);
          inst.qrBase64 = null;
        } else {
          console.log(`[Baileys:${instanceId}] Conexão fechada (code=${code}) — reconectando em 8s...`);
          setTimeout(() => start(instanceId), 8000);
        }
      }
    });
  } catch (err) {
    inst.starting = false;
    console.error(`[Baileys:${instanceId}] Erro ao iniciar:`, err.message);
    setTimeout(() => start(instanceId), 15000);
  }
}

// Inicia todas as instâncias salvas no banco ao subir o servidor
async function initAll() {
  const ids = await listInstances();
  if (!ids.includes("default")) ids.push("default");
  for (const id of ids) {
    await start(id);
  }
}

// ── Envio ──────────────────────────────────────────────────────
async function sendText(to, text, instanceId = "default") {
  const inst = INSTANCES.get(instanceId);
  if (!inst || !inst.socket || inst.status !== "connected") return false;

  if (!inst.notifyTo.includes(to)) {
    console.warn(`[Baileys:${instanceId}] Envio bloqueado para ${to} — não está na lista.`);
    return false;
  }

  if (!checkLimits(inst)) return false;

  try {
    const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
    await inst.socket.sendMessage(jid, { text });
    inst.counters.hour++;
    inst.counters.day++;

    // Registrar no histórico do painel (Pappi Atendente)
    try {
      const botHandler = require("../routes/bot.handler");
      const cleanPhone = to.split("@")[0];
      // Como o Baileys é global por enquanto, usamos o tenant padrão
      await botHandler.saveBaileysMessage(cleanPhone, text, "tenant-pappi-001");
    } catch (err) {
      console.error(`[Baileys:${instanceId}] Erro ao registrar msg no histórico:`, err.message);
    }

    return true;
  } catch (err) {
    console.error(`[Baileys:${instanceId}] Erro ao enviar:`, err.message);
    return false;
  }
}

async function notify(text) {
  for (const inst of INSTANCES.values()) {
    if (inst.status === "connected" && inst.notifyTo.length) {
      await Promise.all(inst.notifyTo.map(n => sendText(n, text, inst.id)));
    }
  }
}

function getStatus(instanceId = "default") {
  const inst = INSTANCES.get(instanceId);
  if (!inst) return { status: "disconnected" };
  resetCounters(inst);
  return {
    id:        inst.id,
    status:    inst.status,
    qr:        inst.qrBase64,
    lastAlert: inst.lastAlert,
    account:   inst.account,
    usage: {
      hour:    inst.counters.hour,
      hourMax: LIMITS.perHour,
      day:     inst.counters.day,
      dayMax:  LIMITS.perDay,
    },
  };
}

function getAllStatuses() {
  return Array.from(INSTANCES.keys()).map(id => getStatus(id));
}

function setNotifyNumbers(numbers, instanceId = "default") {
  let inst = INSTANCES.get(instanceId);
  if (!inst) {
    inst = createInstanceData(instanceId);
    INSTANCES.set(instanceId, inst);
  }
  inst.notifyTo = Array.isArray(numbers) ? numbers : [];
}

function disconnect(instanceId = "default") {
  const inst = INSTANCES.get(instanceId);
  if (!inst) return;
  inst.starting = false;
  if (inst.socket) { try { inst.socket.end(); } catch(e) {} }
  clearDbAuth(instanceId).catch(()=>{});
  inst.status   = "disconnected";
  inst.socket   = null;
  inst.qrBase64 = null;
  if (instanceId !== "default") INSTANCES.delete(instanceId);
}

async function getProfilePicture(phone) {
  for (const inst of INSTANCES.values()) {
    if (inst.socket && inst.status === "connected") {
      try {
        const jid = `${phone}@s.whatsapp.net`;
        const url = await inst.socket.profilePictureUrl(jid, "image");
        if (url) return url;
      } catch {}
    }
  }
  return null;
}

module.exports = { start, initAll, sendText, notify, getStatus, getAllStatuses, setNotifyNumbers, disconnect, getProfilePicture };
