// src/services/baileys.service.js
// Multi-WhatsApp via Baileys (QR Code) para notificações INTERNAS da equipe
//
// IMPORTANTE: Toda a lógica usa o instanceId (a CONEXÃO), nunca o número conectado.
// Qualquer número pode ser conectado a qualquer instância — ao reconectar/reescanear
// o QR, o número pode mudar. O que importa é a instância (ex: "default", "drmlogistica").

const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const { useDbAuthState, clearDbAuth, listInstances } = require("./baileys-db-auth");
const QRCode = require("qrcode");
const prisma = require("../lib/db");

// ── Limites de segurança por instância (bot + notificações) ─────
const LIMITS = { perHour: 60, perDay: 200, alertAt: 0.7 };

const INSTANCES = new Map();

function createInstanceData(id) {
  return {
    id,
    socket: null,
    qrBase64: null,
    status: "disconnected",
    starting: false,
    lastAlert: null,
    account: null,
    notifyTo: [],
    botEnabled: true,
    _reconnectDelay: 8000,
    counters: {
      hour: 0,
      day: 0,
      hourReset: Date.now() + 3600_000,
      dayReset: Date.now() + 86_400_000,
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
  const dayPct = inst.counters.day / LIMITS.perDay;

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
// instanceId: se informado e número for novo, usa tenant do Config baileys:instance:{id}
async function detectTenantByPhone(phone, instanceId = null) {
  try {
    const PhoneNormalizer = require("../normalizers/PhoneNormalizer");
    const normalized = PhoneNormalizer.normalize(phone);
    if (!normalized) return null;

    const customer = await prisma.customer.findFirst({
      where: { phone: normalized },
      select: { tenantId: true },
      orderBy: { lastInteraction: "desc" },
    });

    if (customer?.tenantId) return customer.tenantId;

    // Número novo: tenta tenant da instância (Config baileys:instance:{id})
    if (instanceId) {
      const cfg = await prisma.config.findUnique({
        where: { key: `baileys:instance:${instanceId}` },
      });
      if (cfg?.value) {
        try {
          const { tenantId } = JSON.parse(cfg.value);
          if (tenantId) {
            console.log(`[Baileys] Número novo ${normalized} — tenant da instância ${instanceId}`);
            return tenantId;
          }
        } catch {}
      }
    }

    // Fallback: primeiro tenant ativo
    const fallbackTenant = await prisma.tenant.findFirst({
      where: { active: true },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });

    if (fallbackTenant) {
      console.log(`[Baileys] Número novo ${normalized} — atribuído ao tenant ${fallbackTenant.id} (fallback)`);
    }

    return fallbackTenant?.id || null;
  } catch {
    return null;
  }
}

// Salva o canal de resposta para o customer (cloud ou baileys:instanceId)
async function setReplyChannel(customerId, channel) {
  try {
    await prisma.config.upsert({
      where: { key: `reply_channel:${customerId}` },
      create: { key: `reply_channel:${customerId}`, value: channel },
      update: { value: channel },
    });
  } catch (e) {
    console.error("[Baileys] Erro ao salvar reply_channel:", e.message);
  }
}

// Retorna o canal de resposta do customer (cloud | baileys:instanceId)
async function getReplyChannel(customerId) {
  try {
    const cfg = await prisma.config.findUnique({
      where: { key: `reply_channel:${customerId}` },
    });
    return cfg?.value || "cloud";
  } catch {
    return "cloud";
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
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: require("pino")({ level: "silent" }),
      browser: ["Pappi Atendente", "Chrome", "1.0"],
      qrTimeout: 60000,
    });

    inst.socket = sock;
    inst.status = "connecting";
    inst.starting = false;

    sock.ev.on("creds.update", saveCreds);

    // Captura mensagens recebidas
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (!jid || jid.endsWith("@g.us")) continue; // ignora grupos

        const phone = jid.split("@")[0];
        let text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          null;
        if (!text) {
          const btnResp = msg.message?.buttonsResponseMessage;
          if (btnResp) {
            const id = btnResp.selectedButtonId;
            const flowIds = ["delivery", "takeout", "confirm_addr", "change_addr", "CONFIRMAR", "CANCELAR", "AVISE_ABERTURA"];
            text = flowIds.includes(id) ? id : (btnResp.selectedDisplayText || id || "");
          }
        }
        // Botões enviados como texto: mapeia respostas comuns para ids (Corrigir, Cancelar)
        if (text) {
          const t = text.toLowerCase().replace(/[✅✏️❌]/g, "").trim();
          if (t === "corrigir") text = "change_addr";
          else if (t === "cancelar") text = "CANCELAR";
          else if (t === "confirmar" || t === "confirma") text = "confirm_addr"; // address ou order — handler trata
        }
        if (!text) continue;

        try {
          // Lido + digitando (Baileys) — cliente vê ✓✓ e "digitando..."
          try {
            await sock.readMessages([msg.key]);
            await sock.sendPresenceUpdate("composing", jid);
          } catch {}

          try {
            const tenantId = await detectTenantByPhone(phone, instanceId);
            if (!tenantId) {
              console.warn(`[Baileys:${instanceId}] Tenant não encontrado para ${phone} — msg ignorada`);
              continue;
            }

            const { findOrCreate, touchInteraction } = require("../services/customer.service");
            const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
            if (!tenant) continue;

            // Cria customer ANTES de salvar msg — números novos não existiam e msg era descartada
            const customer = await findOrCreate(tenantId, phone, null);
            await touchInteraction(customer.id);
            await setReplyChannel(customer.id, `baileys:${instanceId}`);

            const botHandler = require("../routes/bot.handler");
            await botHandler.saveBaileysMessage(customer.phone, text, tenantId, "customer");

            if (inst.botEnabled !== false) {
              try {
                const convState = require("./conversation-state.service");
                await convState.resetIfEncerrado(customer);
                const botMayRespond = await convState.shouldBotRespond(customer);
                if (!botMayRespond) continue;
                const wa = {
                  sendText: (to, msg) => sendText(to, msg, instanceId, true),
                  sendButtons: (to, body, buttons) =>
                    sendText(to, body + "\n\n" + (buttons?.map((b) => b.title).join(" | ") || ""), instanceId, true),
                  sendImage: () => {},
                  sendDocument: () => {},
                };
                await botHandler.handle({ tenant, wa, customer, text, phone: customer.phone });
                require("./socket.service").emitConvUpdate(customer.id);
              } catch (e) {
                console.error(`[Baileys:${instanceId}] Erro no bot:`, e.message);
              }
            }
          } finally {
            // Para o "digitando" — evita ficar travado quando não há resposta
            try {
              await sock.sendPresenceUpdate("paused", jid);
            } catch {}
          }
        } catch (err) {
          console.error(`[Baileys:${instanceId}] Erro ao processar msg:`, err.message);
          try {
            await sock.sendPresenceUpdate("paused", jid);
          } catch {}
        }
      }
    });

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        inst.status = "qr";
        inst.qrBase64 = await QRCode.toDataURL(qr);
        console.log(`[Baileys:${instanceId}] QR Code gerado`);
      }

      if (connection === "open") {
        inst.status = "connected";
        inst.qrBase64 = null;
        inst.starting = false;
        const user = sock.user;
        inst.account = {
          phone: user?.id?.split(":")[0] || user?.id || "?",
          name: user?.name || "?",
        };
        console.log(`[Baileys:${instanceId}] Conectado como ${inst.account.name} (${inst.account.phone})`);
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        const replaced = code === DisconnectReason.connectionReplaced; // 440
        inst.status = "disconnected";
        inst.socket = null;
        inst.starting = false;

        if (loggedOut) {
          console.log(`[Baileys:${instanceId}] Logout — limpando auth.`);
          await clearDbAuth(instanceId);
          inst.qrBase64 = null;
          inst._reconnectDelay = 8000;
        } else if (replaced) {
          // Outra sessão substituiu esta — espera mais antes de reconectar
          inst._reconnectDelay = Math.min((inst._reconnectDelay || 8000) * 2, 300_000);
          console.log(
            `[Baileys:${instanceId}] Sessão substituída (440) — reconectando em ${inst._reconnectDelay / 1000}s...`,
          );
          setTimeout(() => start(instanceId), inst._reconnectDelay);
        } else {
          inst._reconnectDelay = 8000;
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
async function sendText(to, text, instanceId = "default", skipNotifyCheck = false) {
  const inst = INSTANCES.get(instanceId);
  if (!inst || !inst.socket || inst.status !== "connected") return false;

  // notifyTo só se aplica a notificações internas — bot e respostas diretas são liberados
  if (!skipNotifyCheck && inst.notifyTo.length > 0 && !inst.notifyTo.includes(to)) {
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
      const tenantId = await detectTenantByPhone(cleanPhone);
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
      await Promise.all(inst.notifyTo.map((n) => sendText(n, text, inst.id)));
    }
  }
}

async function getInstanceTenant(instanceId) {
  try {
    const cfg = await prisma.config.findUnique({
      where: { key: `baileys:instance:${instanceId}` },
    });
    if (cfg?.value) {
      const { tenantId } = JSON.parse(cfg.value);
      return tenantId || null;
    }
  } catch {}
  return null;
}

async function setInstanceTenant(instanceId, tenantId) {
  await prisma.config.upsert({
    where: { key: `baileys:instance:${instanceId}` },
    create: { key: `baileys:instance:${instanceId}`, value: JSON.stringify({ tenantId: tenantId || null }) },
    update: { value: JSON.stringify({ tenantId: tenantId || null }) },
  });
}

async function getStatus(instanceId = "default") {
  const inst = INSTANCES.get(instanceId);
  if (!inst) return { status: "disconnected" };
  resetCounters(inst);
  const instanceTenant = await getInstanceTenant(instanceId);
  return {
    id: inst.id,
    status: inst.status,
    qr: inst.qrBase64,
    lastAlert: inst.lastAlert,
    account: inst.account,
    botEnabled: inst.botEnabled !== false,
    instanceTenant: instanceTenant,
    usage: {
      hour: inst.counters.hour,
      hourMax: LIMITS.perHour,
      day: inst.counters.day,
      dayMax: LIMITS.perDay,
    },
  };
}

function setBotEnabled(instanceId = "default", enabled) {
  const inst = INSTANCES.get(instanceId);
  if (inst) inst.botEnabled = !!enabled;
}

async function getAllStatuses() {
  return Promise.all(Array.from(INSTANCES.keys()).map((id) => getStatus(id)));
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
  if (inst.socket) {
    try {
      inst.socket.end();
    } catch (e) {}
  }
  clearDbAuth(instanceId).catch(() => {});
  inst.status = "disconnected";
  inst.socket = null;
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
  start,
  initAll,
  sendText,
  notify,
  getStatus,
  getAllStatuses,
  setNotifyNumbers,
  setBotEnabled,
  setInstanceTenant,
  disconnect,
  getProfilePicture,
  getReplyChannel,
  setReplyChannel,
};
