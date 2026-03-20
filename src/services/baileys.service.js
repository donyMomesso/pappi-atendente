// src/services/baileys.service.js
// Multi-WhatsApp via Baileys (QR Code) para notificações INTERNAS da equipe
// CORREÇÕES:
//   - tenantId não é mais hardcoded — detectado pelo número do remetente
//   - Usa singleton do PrismaClient

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { useDbAuthState, clearDbAuth, listInstances } = require("./baileys-db-auth");
const QRCode = require("qrcode");
const prisma  = require("../lib/db");

// ── Limites de segurança por instância ──────────────────────────
const LIMITS = { perHour: 20, perDay: 80, alertAt: 0.7 };

const INSTANCES = new Map();

function createInstanceData(id) {
  return {
    id, socket: null, qrBase64: null, status: "disconnected",
    starting: false, lastAlert: null, account: null, notifyTo: [],
    counters: {
      hour: 0, day: 0,
      hourReset: Date.now() + 3600_000,
      dayReset:  Date.now() + 86_400_000,
      alerted: { hour: false, day: false },
    },
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
    inst.lastAlert = `⚠️ [${inst.id}] Atenção: ${inst.counters.hour}/${LIMITS.perHour} msgs/h (${Math.round(hourPct * 100)}%).`;
  }
  if (dayPct >= LIMITS.alertAt && !inst.counters.alerted.day) {
    inst.counters.alerted.day = true;
    inst.lastAlert = `⚠️ [${inst.id}] Atenção: ${inst.counters.day}/${LIMITS.perDay} msgs/dia (${Math.round(dayPct * 100)}%).`;
  }
  if (inst.counters.hour >= LIMITS.perHour) {
    inst.lastAlert = `🚫 [${inst.id}] Limite HORÁRIO atingido.`;
    return false;
  }
  if (inst.counters.day >= LIMITS.perDay) {
    inst.lastAlert = `🚫 [${inst.id}] Limite DIÁRIO atingido.`;
    return false;
  }
  return true;
}

// ── Detecta tenantId a partir do número do remetente ──────────
// Busca o customer no banco pelo telefone e retorna o tenantId dele.
// Retorna null se não encontrar (mensagem de número desconhecido).
async function detectTenantByPhone(phone) {
  try {
    const PhoneNormalizer = require("../normalizers/PhoneNormalizer");
    const normalized = PhoneNormalizer.normalize(phone);
    if (!normalized) return null;

    const customer = await prisma.customer.findFirst({
      where:  { phone: normalized },
      select: { tenantId: true },
      orderBy: { lastInteraction: "desc" },
    });

    return customer?.tenantId || null;
  } catch {
    return null;
  }
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
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth:              state,
      printQRInTerminal: false,
      logger:            require("pino")({ level: "silent" }),
      browser:           ["Pappi Atendente", "Chrome", "1.0"],
      qrTimeout:         60000,
    });

    inst.socket   = sock;
    inst.status   = "connecting";
    inst.starting = false;

    sock.ev.on("creds.update", saveCreds);

    // Captura mensagens recebidas e salva no histórico do painel
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (!jid || jid.endsWith("@g.us")) continue; // ignora grupos

        const phone = jid.split("@")[0];
        const text  = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || msg.message?.imageMessage?.caption
          || null;
        if (!text) continue;

        try {
          // CORREÇÃO: detecta o tenantId pelo telefone em vez de usar valor fixo
          const tenantId = await detectTenantByPhone(phone);
          if (!tenantId) {
            console.warn(`[Baileys:${instanceId}] Tenant não encontrado para ${phone} — msg ignorada`);
            continue;
          }

          const botHandler = require("../routes/bot.handler");
          await botHandler.saveBaileysMessage(phone, text, tenantId, "customer");
        } catch (err) {
          console.error(`[Baileys:${instanceId}] Erro ao salvar msg recebida:`, err.message);
        }
      }
    });

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
        const user    = sock.user;
        inst.account  = {
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

async function initAll() {
  const ids = await listInstances();
  if (!ids.includes("default")) ids.push("default");
  for (const id of ids) await start(id);
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

    // CORREÇÃO: detecta tenantId corretamente antes de salvar no histórico
    try {
      const botHandler = require("../routes/bot.handler");
      const cleanPhone = to.split("@")[0];
      const tenantId   = await detectTenantByPhone(cleanPhone);
      if (tenantId) {
        await botHandler.saveBaileysMessage(cleanPhone, text, tenantId, "assistant");
      }
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
  if (inst.socket) { try { inst.socket.end(); } catch (e) {} }
  clearDbAuth(instanceId).catch(() => {});
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

module.exports = {
  start, initAll, sendText, notify,
  getStatus, getAllStatuses, setNotifyNumbers, disconnect, getProfilePicture,
};
