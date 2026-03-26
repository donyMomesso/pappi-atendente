// src/services/baileys.service.js
// Multi-WhatsApp via Baileys (QR Code) para notificações INTERNAS da equipe
//
// IMPORTANTE: Toda a lógica usa o instanceId (a CONEXÃO), nunca o número conectado.
// Qualquer número pode ser conectado a qualquer instância — ao reconectar/reescanear
// o QR, o número pode mudar. O que importa é a instância (ex: "default", "drmlogistica").

const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const { useDbAuthState, clearDbAuth, listInstances } = require("./baileys-db-auth");
const baileysLock = require("./baileys-lock.service");
const QRCode = require("qrcode");
const prisma = require("../lib/db");
const messageDbCompat = require("../lib/message-db-compat");
const ENV = require("../config/env");
const log = require("../lib/logger").child({ service: "baileys" });
const messageBuffer = require("./message-buffer.service");
const { parseBaileysMessageContent } = require("../lib/baileys-message-content");

function instanceConfigKey(instanceId) {
  const env = ENV.APP_ENV || "local";
  return `baileys:instance:${env}:${instanceId}`;
}

// ── Limites de segurança por instância (bot + notificações) ─────
const LIMITS = { perHour: 60, perDay: 200, alertAt: 0.7 };

const INSTANCES = new Map();

// Cache de waMessageIds já vistos — evita query no banco para duplicatas rápidas
const SEEN_MSG_IDS = new Set();
const SEEN_MSG_MAX = 2000;
const RECONNECT_NOTICE_BY_CUSTOMER = new Map();
const RECONNECT_BOT_SUPPRESS_UNTIL = new Map();
function markMessageProcessed(waId) {
  if (!waId) return;
  if (SEEN_MSG_IDS.size >= SEEN_MSG_MAX) {
    const arr = [...SEEN_MSG_IDS];
    arr.slice(0, Math.floor(SEEN_MSG_MAX / 2)).forEach((id) => SEEN_MSG_IDS.delete(id));
  }
  SEEN_MSG_IDS.add(waId);
}

// Cache da versão Baileys — evita chamar URL externa a cada reconexão
let _cachedVersion = null;
async function getBaileysVersion() {
  if (_cachedVersion) return _cachedVersion;
  const { version } = await fetchLatestBaileysVersion();
  _cachedVersion = version;
  // Invalida o cache após 1h para não usar versão muito antiga
  setTimeout(() => {
    _cachedVersion = null;
  }, 3_600_000);
  return version;
}

/** Tentativas de reconexão automática antes de exigir ação manual no painel. */
const MAX_AUTO_RECONNECT_ATTEMPTS = 10;
/** Cooldown entre avisos Socket.IO (painel) por queda — evita loop de overlay. */
const DISCONNECT_NOTIFY_COOLDOWN_MS = 60_000;
/** Backoff progressivo (ms); último valor repete após esgotar a lista. */
const RECONNECT_BACKOFF_MS = [5000, 8000, 16_000, 32_000, 60_000, 120_000];
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const BOT_FRESH_WINDOW_MS = 2 * 60 * 1000;
const RECONNECT_NOTICE_COOLDOWN_MS = 5 * 60 * 1000;

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
    _replaced440Count: 0,
    _genericDisconnectCount: 0,
    _lastDisconnectAt: 0,
    _heartbeatInterval: null,
    /** Monótono: handlers de sockets antigos ignoram eventos quando !== inst._socketEpoch. */
    _socketEpoch: 0,
    /** Um único timer de reconexão por instância. */
    _reconnectTimer: null,
    /** Throttle de emitBaileysDisconnected (servidor). */
    lastDisconnectNotifyAt: 0,
    /** Após muitas falhas, não chamar start() até Conectar (force) no painel. */
    manualReconnectRequired: false,
    counters: {
      hour: 0,
      day: 0,
      hourReset: Date.now() + 3600_000,
      dayReset: Date.now() + 86_400_000,
      alerted: { hour: false, day: false },
    },
  };
}

/** Encerra socket antigo e remove listeners (evita múltiplos connection.update vivos). */
function destroyLivingSocket(inst, reasonTag = "cleanup") {
  const s = inst.socket;
  if (!s) return;
  inst.socket = null;
  try {
    s.end(new Error(`baileys:${reasonTag}`));
  } catch (e) {
    log.debug({ err: e?.message, instanceId: inst.id }, "socket.end (ok se já fechado)");
  }
  try {
    if (s.ev && typeof s.ev.removeAllListeners === "function") s.ev.removeAllListeners();
  } catch (e) {
    log.debug({ err: e?.message }, "ev.removeAllListeners");
  }
}

function backoffMsForAttempt(attemptIndex) {
  const i = Math.max(0, attemptIndex - 1);
  if (i >= RECONNECT_BACKOFF_MS.length) return RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1];
  return RECONNECT_BACKOFF_MS[i];
}

/** Agenda uma única reconexão; cancela timer anterior. */
function scheduleReconnect(instanceId, delayMs) {
  const inst = INSTANCES.get(instanceId);
  if (!inst) return;
  if (inst.manualReconnectRequired) {
    log.warn({ instanceId }, "Baileys: auto-reconnect cancelado — manualReconnectRequired");
    return;
  }
  if (inst._reconnectTimer) {
    clearTimeout(inst._reconnectTimer);
    inst._reconnectTimer = null;
  }
  inst._reconnectTimer = setTimeout(() => {
    inst._reconnectTimer = null;
    start(instanceId).catch((e) => log.error({ instanceId, err: e?.message }, "Baileys: start após backoff falhou"));
  }, delayMs);
}

function maybeEmitBaileysDisconnected(inst, instanceId, reason, opts = {}) {
  const force = opts.force === true;
  const now = Date.now();
  if (
    !force &&
    now - (inst.lastDisconnectNotifyAt || 0) < DISCONNECT_NOTIFY_COOLDOWN_MS
  ) {
    log.debug({ instanceId, reason: reason?.slice?.(0, 80) }, "Baileys: emit disconnect ignorado (cooldown servidor)");
    return;
  }
  inst.lastDisconnectNotifyAt = now;
  try {
    require("./socket.service").emitBaileysDisconnected(instanceId, reason);
  } catch (e) {
    log.warn({ err: e }, "Falha ao emitir baileys_disconnected");
  }
}

function resetReconnectStateOnOpen(inst) {
  inst.manualReconnectRequired = false;
  inst._genericDisconnectCount = 0;
  inst._replaced440Count = 0;
  inst._reconnectDelay = 8000;
  inst.lastDisconnectNotifyAt = 0;
  if (inst._reconnectTimer) {
    clearTimeout(inst._reconnectTimer);
    inst._reconnectTimer = null;
  }
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

// ── Helpers de JID / telefone ──────────────────────────────────
function normalizeToDigits(raw) {
  if (raw == null || raw === "") return "";
  const s = String(raw);
  const part = s.split("@")[0].split(":")[0];
  return part.replace(/\D/g, "");
}

/** Dígitos E.164-like do contato (remoteJidAlt / PN / @s.whatsapp.net). Sem isso, use @lid + waId no Customer. */
function extractPhoneDigitsFromMessage(msg) {
  try {
    const key = msg?.key || {};
    const remoteJid = key.remoteJid || "";
    const m = msg?.message || {};

    // Ordem de prioridade: remoteJidAlt resolve @lid
    const candidates = [
      key.remoteJidAlt,
      key.participantPn,
      key.senderPn,
      msg?.participantPn,
      msg?.senderPn,
      key.participant,
      msg?.participant,
      m?.extendedTextMessage?.contextInfo?.participant,
      m?.imageMessage?.contextInfo?.participant,
      m?.videoMessage?.contextInfo?.participant,
      m?.documentMessage?.contextInfo?.participant,
      m?.buttonsResponseMessage?.contextInfo?.participant,
      m?.listResponseMessage?.contextInfo?.participant,
    ];

    for (const c of candidates) {
      const digits = normalizeToDigits(c);
      if (digits.length >= 10 && digits.length <= 15) return digits;
    }

    if (remoteJid.endsWith("@s.whatsapp.net")) {
      const digits = normalizeToDigits(remoteJid);
      if (digits.length >= 10 && digits.length <= 15) return digits;
    }

    return null;
  } catch {
    return null;
  }
}

/** Telefone normalizado ou conversa @lid (sem dígitos). */
function resolveInboundSender(msg) {
  const key = msg?.key || {};
  const remoteJid = key.remoteJid || "";
  const digits = extractPhoneDigitsFromMessage(msg);
  if (digits) return { kind: "phone", phoneDigits: digits, remoteJid: remoteJid || null };
  if (remoteJid.endsWith("@lid")) return { kind: "lid", phoneDigits: null, remoteJid };
  return null;
}

function resolveBaileysOriginalTimestamp(msg) {
  const raw = msg?.messageTimestamp;
  if (raw == null) return null;
  let seconds = null;
  if (typeof raw === "number") seconds = raw;
  else if (typeof raw === "string") seconds = Number(raw);
  else if (typeof raw === "object") {
    if (typeof raw.low === "number") seconds = raw.low;
    else if (typeof raw.toNumber === "function") {
      try {
        seconds = Number(raw.toNumber());
      } catch {}
    }
  }
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const d = new Date(Math.floor(seconds) * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isMessageWithinLast24h(msg) {
  const ts = resolveBaileysOriginalTimestamp(msg);
  if (!ts) return false;
  return Date.now() - ts.getTime() <= HISTORY_WINDOW_MS;
}

function isFreshForBot(msg) {
  const ts = resolveBaileysOriginalTimestamp(msg);
  if (!ts) return false;
  return Date.now() - ts.getTime() <= BOT_FRESH_WINDOW_MS;
}

function shouldSendReconnectNotice(identityKey) {
  if (!identityKey) return false;
  const now = Date.now();
  const prev = RECONNECT_NOTICE_BY_CUSTOMER.get(identityKey) || 0;
  if (now - prev < RECONNECT_NOTICE_COOLDOWN_MS) return false;
  RECONNECT_NOTICE_BY_CUSTOMER.set(identityKey, now);
  RECONNECT_BOT_SUPPRESS_UNTIL.set(identityKey, now + 90_000);
  if (RECONNECT_NOTICE_BY_CUSTOMER.size > 5000) {
    for (const [cid, at] of RECONNECT_NOTICE_BY_CUSTOMER.entries()) {
      if (now - at > RECONNECT_NOTICE_COOLDOWN_MS * 6) {
        RECONNECT_NOTICE_BY_CUSTOMER.delete(cid);
        RECONNECT_BOT_SUPPRESS_UNTIL.delete(cid);
      }
    }
  }
  return true;
}

function isReconnectSuppressed(identityKey) {
  if (!identityKey) return false;
  const until = RECONNECT_BOT_SUPPRESS_UNTIL.get(identityKey) || 0;
  return Date.now() < until;
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

    // Número novo: tenta tenant da instância (Config baileys:instance:{env}:{id})
    if (instanceId) {
      const cfg = await prisma.config.findUnique({
        where: { key: instanceConfigKey(instanceId) },
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

async function getInstanceTenantBinding(instanceId) {
  if (!instanceId) return null;
  const cfg = await prisma.config.findUnique({
    where: { key: instanceConfigKey(instanceId) },
  });
  if (!cfg?.value) return null;
  try {
    const { tenantId } = JSON.parse(cfg.value);
    return tenantId || null;
  } catch {
    return null;
  }
}

async function bindInstanceTenant(instanceId, tenantId) {
  if (!instanceId || !tenantId) return;
  const key = instanceConfigKey(instanceId);
  let base = { tenantId: null };
  const row = await prisma.config.findUnique({ where: { key } });
  if (row?.value) {
    try {
      base = { ...base, ...JSON.parse(row.value) };
    } catch {}
  }
  const next = { ...base, tenantId };
  await prisma.config.upsert({
    where: { key },
    create: { key, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
}

async function resolveTenantForNewChat(instanceId) {
  const explicit = await getInstanceTenantBinding(instanceId);
  if (explicit) return explicit;
  const fallbackTenant = await prisma.tenant.findFirst({
    where: { active: true },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return fallbackTenant?.id || null;
}

/** Tenant para inbound: telefone (histórico), waId (@lid), ou config da instância / primeiro tenant. */
async function detectTenantForInbound({ phoneDigits, remoteJid }, instanceId) {
  const d = phoneDigits != null ? String(phoneDigits).replace(/\D/g, "") : "";
  if (d.length >= 10 && d.length <= 15) {
    return detectTenantByPhone(d, instanceId);
  }
  if (remoteJid) {
    try {
      const hit = await prisma.customer.findFirst({
        where: { waId: remoteJid },
        select: { tenantId: true },
        orderBy: { lastInteraction: "desc" },
      });
      if (hit?.tenantId) return hit.tenantId;
    } catch {}
  }
  return resolveTenantForNewChat(instanceId);
}

async function detectTenantViaReplyChannel(instanceId) {
  try {
    const rows = await prisma.config.findMany({
      where: { key: { startsWith: "reply_channel:" }, value: `baileys:${instanceId}` },
      select: { key: true },
      take: 500,
    });
    if (!rows.length) return null;
    const customerIds = rows
      .map((r) => String(r.key || "").replace("reply_channel:", ""))
      .filter(Boolean);
    if (!customerIds.length) return null;
    const hit = await prisma.customer.findFirst({
      where: { id: { in: customerIds } },
      orderBy: { lastInteraction: "desc" },
      select: { tenantId: true, id: true },
    });
    if (!hit?.tenantId) return null;
    return { tenantId: hit.tenantId, customerId: hit.id, criterion: "reply_channel_instance" };
  } catch {
    return null;
  }
}

async function resolveTenantContextForInbound({ phoneDigits, remoteJid, instanceId, jid, waMessageId }) {
  const attempts = [];

  const explicitInstanceTenant = await getInstanceTenantBinding(instanceId);
  attempts.push({ criterion: "instance_binding", tenantId: explicitInstanceTenant || null });
  if (explicitInstanceTenant) {
    return { tenantId: explicitInstanceTenant, criterion: "instance_binding", attempts };
  }

  const byReplyChannel = await detectTenantViaReplyChannel(instanceId);
  attempts.push({
    criterion: "reply_channel_instance",
    tenantId: byReplyChannel?.tenantId || null,
    customerId: byReplyChannel?.customerId || null,
  });
  if (byReplyChannel?.tenantId) {
    return { tenantId: byReplyChannel.tenantId, criterion: byReplyChannel.criterion, attempts };
  }

  // 3) Tenta pelo número da sessão conectada nesta instância (quando disponível)
  try {
    const inst = INSTANCES.get(instanceId);
    const connectedPhone = inst?.account?.phone ? String(inst.account.phone).replace(/\D/g, "") : "";
    if (connectedPhone.length >= 10) {
      const byConnectedSession = await detectTenantByPhone(connectedPhone, instanceId);
      attempts.push({
        criterion: "connected_session_number",
        sessionPhone: connectedPhone,
        tenantId: byConnectedSession || null,
      });
      if (byConnectedSession) {
        return { tenantId: byConnectedSession, criterion: "connected_session_number", attempts };
      }
    } else {
      attempts.push({
        criterion: "connected_session_number",
        sessionPhone: connectedPhone || null,
        tenantId: null,
      });
    }
  } catch {
    attempts.push({ criterion: "connected_session_number", tenantId: null, reason: "lookup_error" });
  }

  // 4) Identidade da mensagem inbound (phone/jid/waId)
  const byIdentity = await detectTenantForInbound({ phoneDigits, remoteJid }, instanceId);
  attempts.push({ criterion: "inbound_identity", tenantId: byIdentity || null });
  if (byIdentity) {
    return { tenantId: byIdentity, criterion: "inbound_identity", attempts };
  }

  // 5) Fallback seguro da arquitetura: se houver apenas 1 tenant ativo, vincula automaticamente a instância.
  const activeTenants = await prisma.tenant.findMany({
    where: { active: true },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: 2,
  });
  attempts.push({ criterion: "active_tenants_count", count: activeTenants.length });
  if (activeTenants.length === 1) {
    const tid = activeTenants[0].id;
    await bindInstanceTenant(instanceId, tid).catch(() => {});
    attempts.push({ criterion: "auto_bind_single_active_tenant", tenantId: tid });
    return {
      tenantId: tid,
      criterion: "auto_bind_single_active_tenant",
      attempts,
    };
  }

  const byAnyTenant = await prisma.tenant.findFirst({
    where: {},
    select: { id: true, active: true },
    orderBy: { createdAt: "asc" },
  });
  attempts.push({
    criterion: "any_tenant_last_resort",
    tenantId: byAnyTenant?.id || null,
    tenantActive: byAnyTenant?.active ?? null,
  });
  if (byAnyTenant?.id) {
    return { tenantId: byAnyTenant.id, criterion: "any_tenant_last_resort", attempts };
  }

  return {
    tenantId: null,
    criterion: "not_found",
    attempts,
    context: { instanceId, jid: jid || null, remoteJid: remoteJid || null, waMessageId: waMessageId || null },
  };
}

async function appendUnresolvedInboundAudit(payload) {
  try {
    const env = ENV.APP_ENV || "local";
    const key = `baileys:unresolved_tenant:${env}`;
    const row = await prisma.config.findUnique({ where: { key } });
    let items = [];
    if (row?.value) {
      try {
        const parsed = JSON.parse(row.value);
        if (Array.isArray(parsed)) items = parsed;
      } catch {}
    }
    items.push({ ...payload, at: new Date().toISOString() });
    const max = 200;
    if (items.length > max) items = items.slice(items.length - max);
    await prisma.config.upsert({
      where: { key },
      create: { key, value: JSON.stringify(items) },
      update: { value: JSON.stringify(items) },
    });
  } catch {}
}

async function appendProtocolAudit(payload) {
  try {
    const env = ENV.APP_ENV || "local";
    const key = `baileys:protocol_events:${env}`;
    const row = await prisma.config.findUnique({ where: { key } });
    let items = [];
    if (row?.value) {
      try {
        const parsed = JSON.parse(row.value);
        if (Array.isArray(parsed)) items = parsed;
      } catch {}
    }
    items.push({ ...payload, at: new Date().toISOString() });
    const max = 300;
    if (items.length > max) items = items.slice(items.length - max);
    await prisma.config.upsert({
      where: { key },
      create: { key, value: JSON.stringify(items) },
      update: { value: JSON.stringify(items) },
    });
  } catch {}
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
// opts.force = true: reconexão manual após 440 — permite clicar "Conectar" no painel
async function start(instanceId = "default", opts = {}) {
  let inst = INSTANCES.get(instanceId);
  if (!inst) {
    inst = createInstanceData(instanceId);
    INSTANCES.set(instanceId, inst);
  }
  await applyInstancePrefsFromDb(instanceId, inst);

  const force = opts.force === true;

  if (inst.manualReconnectRequired && !force) {
    log.warn(
      { instanceId },
      "Baileys: reconexão automática desativada após falhas repetidas — use Conectar no painel (WhatsApp Interno).",
    );
    return;
  }
  if (force) {
    inst.manualReconnectRequired = false;
    inst._genericDisconnectCount = 0;
  }

  if (inst.status === "conflict" && !force) return;
  if (force && inst.status === "conflict") {
    inst.status = "disconnected";
    inst._replaced440Count = 0;
    log.info({ instanceId }, "Reconexão manual após 440 — limpando estado");
  }

  if (inst.starting || inst.status === "connected" || inst.status === "qr" || inst.status === "connecting") return;

  inst.starting = true;

  try {
    // Lock: evita dois processos assumirem a mesma sessão (440)
    const lockAcquired = await baileysLock.acquireLock(instanceId);
    if (!lockAcquired) {
      inst.starting = false;
      inst.status = "disconnected";
      const ttl = ENV.BAILEYS_LOCK_TTL_MS || 60_000;
      const retryMs = Math.max(8000, Math.floor(ttl / 2));
      log.warn(
        {
          instanceId,
          appEnv: ENV.APP_ENV,
          hostname: ENV.BAILEYS_HOSTNAME || require("os").hostname(),
          pid: process.pid,
          retryInMs: retryMs,
        },
        "Boot recusado — outro processo detém o lock da instância",
      );
      // Importante em deploy/rolling restart: quando o owner anterior cair, este processo volta
      // a tentar automaticamente e reassume a sessão sem intervenção manual.
      scheduleReconnect(instanceId, retryMs);
      return;
    }
    log.info(
      { instanceId, appEnv: ENV.APP_ENV, owner: baileysLock.ownerId() },
      "Lock adquirido — iniciando conexão Baileys",
    );

    if (inst._heartbeatInterval) {
      clearInterval(inst._heartbeatInterval);
      inst._heartbeatInterval = null;
    }

    inst._socketEpoch = (inst._socketEpoch || 0) + 1;
    const myEpoch = inst._socketEpoch;

    destroyLivingSocket(inst, "new_session");

    if (inst._reconnectTimer) {
      clearTimeout(inst._reconnectTimer);
      inst._reconnectTimer = null;
    }

    // Pequena pausa após desconexão recente — evita 440 por "auto-substituição" em restarts rápidos (ex: Render wake)
    const sinceDisconnect = Date.now() - (inst._lastDisconnectAt || 0);
    if (sinceDisconnect < 5000 && !force) {
      await new Promise((r) => setTimeout(r, 3000));
    }

    const { state, saveCreds } = await useDbAuthState(instanceId);
    const version = await getBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: require("pino")({ level: "silent" }),
      browser: ["Pappi Atendente", "Chrome", "1.0"],
      qrTimeout: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    inst.socket = sock;
    inst.status = "connecting";
    inst.starting = false;

    sock.ev.on("creds.update", async () => {
      if (myEpoch !== inst._socketEpoch) return;
      try {
        await saveCreds();
      } catch (e) {
        log.warn({ instanceId, err: e?.message }, "creds.update falhou");
      }
    });

    // Captura mensagens recebidas (notify = nova em tempo real, append = histórico após reconexão)
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (myEpoch !== inst._socketEpoch) return;
      if (type !== "notify" && type !== "append") return;
      const isAppend = type === "append";

      const recoverySent = new Set(); // evita mandar "Voltei!" várias vezes no mesmo batch

      for (const msg of messages) {
        const jid = msg?.key?.remoteJid;
        const originalTs = resolveBaileysOriginalTimestamp(msg);

        if (!jid || jid.endsWith("@g.us")) continue; // ignora grupos
        if (jid === "status@broadcast" || jid.endsWith("@broadcast")) continue; // ignora status/stories
        if (isAppend && !isMessageWithinLast24h(msg)) {
          log.debug(
            {
              pipeline: "history_skip_old",
              source: "upsert_append",
              instanceId,
              jid,
              keyId: msg?.key?.id || null,
              originalTimestamp: originalTs ? originalTs.toISOString() : null,
            },
            "Mensagem append fora da janela de 24h — ignorada",
          );
          continue;
        }

        // Mensagens enviadas pelo próprio número (respondidas pelo app/celular)
        // → salva no histórico como "human" para aparecer no painel
        if (msg?.key?.fromMe) {
          try {
            const echoParsed = parseBaileysMessageContent(msg);
            if (echoParsed.mediaType === "empty") {
              continue;
            }
            if (echoParsed.mediaType === "protocol") {
              const auditPayload = {
                pipeline: "protocol_ignored",
                direction: "from_me",
                instanceId,
                jid,
                keyId: msg?.key?.id || null,
                parseNote: echoParsed.parseNote || null,
                displayText: echoParsed.displayText || null,
              };
              log.info(auditPayload, "protocol_ignored");
              await appendProtocolAudit(auditPayload);
              continue;
            }
            const echoIdentity = resolveInboundSender(msg);
            if (!echoIdentity) {
              log.warn(
                {
                  instanceId,
                  jid,
                  pipeline: "contact_resolved",
                  keyId: msg?.key?.id,
                  remoteJidAlt: msg?.key?.remoteJidAlt,
                },
                "Echo fromMe: identidade do chat não resolvida",
              );
              continue;
            }
            const echoTenantCtx = await resolveTenantContextForInbound({
              phoneDigits: echoIdentity.phoneDigits,
              remoteJid: echoIdentity.remoteJid,
              instanceId,
              jid,
              waMessageId: msg?.key?.id || null,
            });
            const echoTenantId = echoTenantCtx?.tenantId || null;
            if (!echoTenantId) {
              log.warn(
                {
                  pipeline: "tenant_resolve_failed",
                  instanceId,
                  jid,
                  remoteJid: echoIdentity.remoteJid || null,
                  sessionIdentifier: `baileys:${instanceId}`,
                  criterion: echoTenantCtx?.criterion || "not_found",
                  attempts: echoTenantCtx?.attempts || [],
                  keyId: msg?.key?.id || null,
                },
                "Echo fromMe sem tenant resolvido — evento auditado",
              );
              await appendUnresolvedInboundAudit({
                instanceId,
                jid,
                remoteJid: echoIdentity.remoteJid || null,
                waMessageId: msg?.key?.id || null,
                criterion: echoTenantCtx?.criterion || "not_found",
                attempts: echoTenantCtx?.attempts || [],
                direction: "from_me",
                textPreview: String(echoParsed?.displayText || "").slice(0, 120),
              });
              continue;
            }

            const { findOrCreate, findOrCreateContactByIdentity } = require("../services/customer.service");
            const echoCustomer =
              echoIdentity.kind === "phone"
                ? await findOrCreate(echoTenantId, echoIdentity.phoneDigits, null)
                : await findOrCreateContactByIdentity({
                    tenantId: echoTenantId,
                    normalizedPhone: null,
                    rawWaId: echoIdentity.remoteJid,
                  });

            const botHandler = require("../routes/bot.handler");
            await botHandler.saveBaileysMessage(
              echoCustomer.phone || echoIdentity.remoteJid,
              echoParsed.displayText,
              echoTenantId,
              "human",
              msg?.key?.id,
              {
                customerId: echoCustomer.id,
                mediaType: echoParsed.mediaType,
                originalTimestamp: resolveBaileysOriginalTimestamp(msg),
              },
            );
            log.info(
              {
                instanceId,
                customerId: echoCustomer.id,
                keyId: msg?.key?.id,
                pipeline: "message_saved",
              },
              "Echo capturado (resposta pelo app)",
            );
            require("./socket.service").emitConvUpdate(echoCustomer.id);
          } catch (echoErr) {
            log.warn(
              { instanceId, err: echoErr.message, pipeline: "save_failed" },
              "Erro ao capturar echo fromMe",
            );
          }
          continue;
        }

        log.info(
          {
            instanceId,
            jid,
            keyId: msg?.key?.id,
            upsertType: type,
            pipeline: "message_received",
            pid: process.pid,
            lockOwner: baileysLock.ownerId(),
          },
          "message_received",
        );

        if (!msg?.message) {
          log.warn(
            {
              instanceId,
              jid,
              pipeline: "message_parsed",
              parseNote: "stub_only",
              key: msg?.key,
              messageStubType: msg?.messageStubType,
              messageStubParameters: msg?.messageStubParameters,
            },
            "Mensagem recebida sem payload em msg.message",
          );
          continue;
        }

        const parsed = parseBaileysMessageContent(msg);
        if (parsed.mediaType === "protocol") {
          const auditPayload = {
            pipeline: "protocol_ignored",
            direction: "inbound",
            instanceId,
            jid,
            keyId: msg?.key?.id || null,
            parseNote: parsed.parseNote || null,
            displayText: parsed.displayText || null,
          };
          log.info(auditPayload, "protocol_ignored");
          await appendProtocolAudit(auditPayload);
          continue;
        }
        if (parsed.parseNote === "unknown_message_type" && parsed.rawSnippet) {
          log.warn(
            {
              instanceId,
              jid,
              keyId: msg?.key?.id,
              pipeline: "parse_failed",
              rawSnippet: parsed.rawSnippet,
              unknownKeys: parsed.unknownKeys,
            },
            "unknown_message_type — texto de fallback gravado para o painel",
          );
        }

        log.info(
          {
            instanceId,
            jid,
            keyId: msg?.key?.id,
            pipeline: "message_parsed",
            primaryKey: parsed.primaryKey,
            mediaType: parsed.mediaType,
            parseNote: parsed.parseNote,
            shouldInvokeBot: parsed.shouldInvokeBot,
          },
          "message_parsed",
        );

        const sender = resolveInboundSender(msg);
        if (!sender) {
          log.warn(
            {
              instanceId,
              jid,
              keyId: msg?.key?.id,
              pipeline: "contact_resolved",
              messageKeys: Object.keys(msg.message || {}),
              pushName: msg?.pushName,
            },
            "contact_resolved: falhou — sem telefone nem @lid",
          );
          continue;
        }

        const text = parsed.displayText;
        const waId = msg?.key?.id;

        // Evita reprocessar: cache em memória (duplicatas) ou banco (recovery)
        if (waId) {
          if (SEEN_MSG_IDS.has(waId)) continue;
          let existing = null;
          if (messageDbCompat.isMessagesTableAvailable()) {
            existing = await prisma.message.findFirst({
              where: { waMessageId: waId },
              select: { id: true },
            });
          }
          if (existing) {
            markMessageProcessed(waId);
            continue;
          }
        }

        const traceKey = sender.phoneDigits || sender.remoteJid || jid;
        const { startTimer } = require("../lib/timing");
        const timer = startTimer({ instanceId, phone: traceKey, step: "baileys" });

        log.info(
          {
            instanceId,
            jid,
            traceKey,
            text: text.slice(0, 80),
            type,
            pipeline: isAppend ? "message_received_append" : "message_received",
          },
          isAppend ? "MSG append (recovery)" : "MSG recebida",
        );

        try {
          // Lido + digitando — apenas para notify; append são msgs antigas
          if (!isAppend) {
            try {
              await sock.readMessages([msg.key]);
              await sock.sendPresenceUpdate("composing", jid);
            } catch {}
          }
          timer.mark("read_composing");

          try {
            const tenantCtx = await resolveTenantContextForInbound({
              phoneDigits: sender.phoneDigits,
              remoteJid: sender.remoteJid,
              instanceId,
              jid,
              waMessageId: waId || null,
            });
            const tenantId = tenantCtx?.tenantId || null;
            if (!tenantId) {
              const unresolved = {
                instanceId,
                traceKey,
                jid,
                remoteJid: sender.remoteJid || null,
                sessionIdentifier: `baileys:${instanceId}`,
                criterion: tenantCtx?.criterion || "not_found",
                attempts: tenantCtx?.attempts || [],
                keyId: waId || null,
                pipeline: "tenant_resolve_failed",
                tenantTried: (tenantCtx?.attempts || []).map((a) => a.tenantId).filter(Boolean),
                fallbackAttempted: (tenantCtx?.attempts || []).length > 1,
                reason: tenantCtx?.criterion || "tenant_not_resolved",
              };
              log.warn(unresolved, "Tenant não encontrado — msg ignorada");
              await appendUnresolvedInboundAudit({
                ...unresolved,
                textPreview: String(text || "").slice(0, 160),
                mediaType: parsed?.mediaType || null,
                parseNote: parsed?.parseNote || null,
                direction: "inbound",
              });
              continue;
            }
            log.info(
              {
                instanceId,
                jid,
                remoteJid: sender.remoteJid || null,
                sessionIdentifier: `baileys:${instanceId}`,
                tenantId,
                criterion: tenantCtx?.criterion || "unknown",
                attempts: tenantCtx?.attempts || [],
              },
              "tenant_resolved",
            );

            const {
              findOrCreate,
              findOrCreateContactByIdentity,
              touchInteraction,
              learningKeyFromCustomer,
              baileysChatTarget,
            } = require("../services/customer.service");
            const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
            if (!tenant) {
              log.warn(
                {
                  instanceId,
                  jid,
                  remoteJid: sender.remoteJid || null,
                  sessionIdentifier: `baileys:${instanceId}`,
                  tenantId,
                  criterion: tenantCtx?.criterion || "unknown",
                  reason: "tenant_not_found_in_database",
                  pipeline: "tenant_resolve_failed",
                },
                "Tenant não existe — msg ignorada",
              );
              continue;
            }
            timer.mark("tenant");

            const pushName = msg.pushName || msg.verifiedBizName || null;
            const customer =
              sender.kind === "phone"
                ? await findOrCreate(tenantId, sender.phoneDigits, pushName)
                : await findOrCreateContactByIdentity({
                    tenantId,
                    normalizedPhone: null,
                    rawWaId: sender.remoteJid,
                    profileName: pushName,
                  });
            timer.mark("customer");

            log.info(
              {
                instanceId,
                customerId: customer.id,
                pipeline: "contact_resolved",
                kind: sender.kind,
                waIdField: customer.waId || null,
              },
              "contact_resolved",
            );

            if (pushName && !customer.name) {
              await prisma.customer
                .update({
                  where: { id: customer.id },
                  data: { name: pushName },
                })
                .catch(() => {});
            }

            await touchInteraction(customer.id);
            await setReplyChannel(customer.id, `baileys:${instanceId}`);
            log.info(
              { instanceId, customerId: customer.id, tenantId, pipeline: "conversation_resolved" },
              "conversation_resolved",
            );

            const botHandler = require("../routes/bot.handler");
            await botHandler.saveBaileysMessage(
              customer.phone || sender.remoteJid,
              text,
              tenantId,
              "customer",
              waId || undefined,
              {
                customerId: customer.id,
                mediaType: parsed.mediaType,
                originalTimestamp: resolveBaileysOriginalTimestamp(msg),
              },
            );
            if (waId) markMessageProcessed(waId);
            timer.mark("save_msg");
            log.info(
              { instanceId, customerId: customer.id, waMessageId: waId, pipeline: "message_saved" },
              "message_saved",
            );
            require("./socket.service").emitConvUpdate(customer.id);
            log.info({ instanceId, customerId: customer.id, pipeline: "socket_emitted" }, "socket_emitted");

            try {
              const learning = require("./bot-learning.service");
              await learning.analyzeMessage(
                tenantId,
                learningKeyFromCustomer(customer) || customer.id,
                customer.name || pushName,
                text,
              );
            } catch {}
            timer.mark("sentiment");

            const baileysTo = baileysChatTarget(customer);

            const reconnectIdentityKey = `${tenantId}:${customer.id || customer.phone || sender.remoteJid || "unknown"}`;
            if (isAppend && !recoverySent.has(reconnectIdentityKey) && shouldSendReconnectNotice(reconnectIdentityKey)) {
              recoverySent.add(reconnectIdentityKey);
              const recovery = "Voltei! Desculpe a demora, estava reconectando. Analisando suas mensagens...";
              try {
                if (!baileysTo) {
                  log.warn({ instanceId, customerId: customer.id }, "Recovery: sem JID/telefone para envio Baileys");
                } else {
                  await sendText(baileysTo, recovery, instanceId, true);
                  await botHandler.saveBaileysMessage(baileysTo, recovery, tenantId, "assistant", null, {
                    customerId: customer.id,
                  });
                }
              } catch (e) {
                log.warn({ instanceId, customerId: customer.id, err: e }, "Falha ao enviar msg de retomada");
              }
            }

            const canInvokeBot =
              parsed.shouldInvokeBot &&
              !isAppend &&
              isFreshForBot(msg) &&
              !isReconnectSuppressed(reconnectIdentityKey);
            if (inst.botEnabled !== false && canInvokeBot) {
              try {
                const convState = require("./conversation-state.service");
                const { botMayRespond, state } = await convState.resetIfEncerradoAndShouldBotRespond(customer);
                timer.mark("conv_state");

                if (!botMayRespond) {
                  if (state === "aguardando_humano" && !customer.claimedBy) {
                    log.info(
                      { instanceId, traceKey },
                      "Auto-liberando handoff sem atendente — devolvendo ao bot",
                    );
                    await convState.setState(customer.id, "bot_ativo");
                    customer.handoff = false;
                  } else {
                    log.info({ instanceId, traceKey, state }, "Bot silencioso (handoff/estado)");
                    timer.mark("bot_skip");
                    timer.log(log);
                    continue;
                  }
                }

                const wa = {
                  sendText: async (to, msgText) => {
                    const r = await sendText(to, msgText, instanceId, true, false);
                    if (!r?.ok) log.warn({ instanceId, to }, "Falha ao enviar resposta");
                    return r;
                  },
                  sendButtons: (to, body, buttons) =>
                    sendText(
                      to,
                      body + "\n\n" + (buttons?.map((b) => b.title).join(" | ") || ""),
                      instanceId,
                      true,
                      false,
                    ),
                  sendImage: () => {},
                  sendDocument: () => {},
                };

                log.debug({ instanceId, traceKey }, "Chamando bot.handle");
                const isFast =
                  /^(delivery|takeout|confirm_addr|change_addr|confirmar|cancelar|avise_abertura)$/i.test(
                    String(text || "").trim(),
                  );
                const windowMs = isFast ? messageBuffer.FAST_WINDOW_MS : messageBuffer.DEFAULT_WINDOW_MS;
                const bufferPhoneKey = customer.phone || `cid:${customer.id}`;
                const waTarget = baileysChatTarget(customer) || bufferPhoneKey;
                messageBuffer.enqueue({
                  tenantId,
                  phone: bufferPhoneKey,
                  channel: `baileys:${instanceId}`,
                  text,
                  meta: { kind: isFast ? "interactive" : "text" },
                  windowMs,
                  onFlush: async ({ combinedText }) => {
                    if (!combinedText) return;
                    await botHandler.handle({
                      tenant,
                      wa,
                      customer,
                      text: combinedText,
                      phone: waTarget,
                      timer,
                    });
                  },
                });
                timer.mark("bot_handle");
                require("./socket.service").emitConvUpdate(customer.id);
                timer.log(log);
              } catch (e) {
                log.error({ instanceId, traceKey, err: e }, "Erro no bot");
                timer.mark("bot_error");
                timer.log(log);
                try {
                  const { incrementBotErrorAndCheckHandoff } = require("../services/customer.service");
                  const { shouldHandoff } = await incrementBotErrorAndCheckHandoff(customer.id);
                  const ENV = require("../config/env");
                  const statusUrl = `${ENV.APP_URL || "https://pappiatendente.com.br"}/status`;

                  let fallback;
                  if (shouldHandoff) {
                    const { setHandoff } = require("../services/customer.service");
                    await setHandoff(customer.id, true);
                    fallback =
                      "Como a instabilidade persistiu, você será direcionado para um atendente humano. Aguarde um momento! 👨‍💼";
                  } else {
                    fallback = `Estamos com instabilidade no WhatsApp. Aguarde alguns minutos e tente novamente. Acompanhe: ${statusUrl}\n\nSe persistir, você será direcionado para atendimento humano.`;
                  }
                  const fbTo = baileysChatTarget(customer);
                  if (fbTo) {
                    await sendText(fbTo, fallback, instanceId, true);
                    await botHandler.saveBaileysMessage(fbTo, fallback, tenantId, "assistant", null, {
                      customerId: customer.id,
                    });
                  } else {
                    log.warn({ instanceId, customerId: customer.id }, "Fallback bot: sem destino Baileys");
                  }
                  if (shouldHandoff) {
                    const socketService = require("./socket.service");
                    socketService.emitQueueUpdate();
                    socketService.emitConvUpdate(customer.id);
                  }
                } catch (f) {
                  log.error({ instanceId, err: f }, "Falha ao enviar mensagem de fallback");
                }
              }
            } else if (inst.botEnabled !== false && !canInvokeBot) {
              log.debug(
                {
                  instanceId,
                  customerId: customer.id,
                  mediaType: parsed.mediaType,
                  parseNote: parsed.parseNote,
                  isAppend,
                  freshForBot: isFreshForBot(msg),
                  reconnectSuppressed: isReconnectSuppressed(reconnectIdentityKey),
                  shouldInvokeBot: parsed.shouldInvokeBot,
                },
                "Bot não invocado (backlog/replay ou tipo sem fluxo de pedido)",
              );
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

    // Histórico inicial após login/reconexão: persistir somente últimas 24h, sem invocar bot.
    sock.ev.on("messaging-history.set", async ({ messages }) => {
      if (myEpoch !== inst._socketEpoch) return;
      if (!Array.isArray(messages) || !messages.length) return;
      log.info({ instanceId, total: messages.length, pipeline: "history_sync_started" }, "messaging-history.set recebido");

      for (const msg of messages) {
        const jid = msg?.key?.remoteJid;
        if (!jid || jid.endsWith("@g.us")) continue;
        if (jid === "status@broadcast" || jid.endsWith("@broadcast")) continue;
        if (!isMessageWithinLast24h(msg)) continue;

        try {
          const parsed = parseBaileysMessageContent(msg);
          if (parsed.mediaType === "empty" || parsed.mediaType === "protocol") continue;

          const identity = resolveInboundSender(msg);
          if (!identity) continue;
          const tenantCtx = await resolveTenantContextForInbound({
            phoneDigits: identity.phoneDigits,
            remoteJid: identity.remoteJid,
            instanceId,
            jid,
            waMessageId: msg?.key?.id || null,
          });
          const tenantId = tenantCtx?.tenantId || null;
          if (!tenantId) {
            await appendUnresolvedInboundAudit({
              pipeline: "tenant_resolve_failed",
              source: "history_set",
              instanceId,
              jid,
              remoteJid: identity.remoteJid || null,
              criterion: tenantCtx?.criterion || "not_found",
              attempts: tenantCtx?.attempts || [],
              keyId: msg?.key?.id || null,
              textPreview: String(parsed.displayText || "").slice(0, 120),
            });
            continue;
          }

          const waId = msg?.key?.id || null;
          if (waId) {
            if (SEEN_MSG_IDS.has(waId)) continue;
            let existing = null;
            if (messageDbCompat.isMessagesTableAvailable()) {
              existing = await prisma.message.findFirst({
                where: { waMessageId: waId },
                select: { id: true },
              });
            }
            if (existing) {
              markMessageProcessed(waId);
              continue;
            }
          }

          const { findOrCreate, findOrCreateContactByIdentity } = require("../services/customer.service");
          const customer =
            identity.kind === "phone"
              ? await findOrCreate(tenantId, identity.phoneDigits, msg.pushName || msg.verifiedBizName || null)
              : await findOrCreateContactByIdentity({
                  tenantId,
                  normalizedPhone: null,
                  rawWaId: identity.remoteJid,
                  profileName: msg.pushName || msg.verifiedBizName || null,
                });

          await setReplyChannel(customer.id, `baileys:${instanceId}`);
          const botHandler = require("../routes/bot.handler");
          const role = msg?.key?.fromMe ? "human" : "customer";
          await botHandler.saveBaileysMessage(
            customer.phone || identity.remoteJid,
            parsed.displayText,
            tenantId,
            role,
            waId,
            {
              customerId: customer.id,
              mediaType: parsed.mediaType,
              originalTimestamp: resolveBaileysOriginalTimestamp(msg),
            },
          );
          if (waId) markMessageProcessed(waId);
          require("./socket.service").emitConvUpdate(customer.id);
        } catch (e) {
          log.warn({ instanceId, jid, err: e?.message }, "Falha ao processar item de messaging-history.set");
        }
      }
      log.info({ instanceId, pipeline: "history_sync_completed" }, "messaging-history.set processado (janela 24h)");
    });

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (myEpoch !== inst._socketEpoch) return;

      try {
        if (qr) {
          inst.status = "qr";
          inst.qrBase64 = await QRCode.toDataURL(qr);
          log.info(
            { instanceId, appEnv: ENV.APP_ENV, owner: baileysLock.ownerId() },
            "QR Code gerado — escaneie no WhatsApp",
          );
        }

        if (connection === "open") {
          inst.status = "connected";
          inst.qrBase64 = null;
          inst.starting = false;
          resetReconnectStateOnOpen(inst);
          const user = sock.user;
          inst.account = {
            phone: user?.id?.split(":")[0] || user?.id || "?",
            name: user?.name || "?",
          };
          log.info(
            {
              instanceId,
              phone: inst.account.phone,
              name: inst.account.name,
              appEnv: ENV.APP_ENV,
              owner: baileysLock.ownerId(),
            },
            "Baileys connection open",
          );
          if (inst._heartbeatInterval) clearInterval(inst._heartbeatInterval);
          const ttl = ENV.BAILEYS_LOCK_TTL_MS || 60_000;
          inst._heartbeatInterval = setInterval(() => baileysLock.heartbeat(instanceId), Math.floor(ttl / 2));
        }

        if (connection === "close") {
          const code = lastDisconnect?.error?.output?.statusCode;
          const errMsg = lastDisconnect?.error?.message || "";
          const loggedOut = code === DisconnectReason.loggedOut;
          const replaced = code === DisconnectReason.connectionReplaced;

          if (inst.socket === sock) inst.socket = null;
          inst.status = "disconnected";
          inst.starting = false;
          inst._lastDisconnectAt = Date.now();

          if (inst._reconnectTimer) {
            clearTimeout(inst._reconnectTimer);
            inst._reconnectTimer = null;
          }

          if (inst._heartbeatInterval) {
            clearInterval(inst._heartbeatInterval);
            inst._heartbeatInterval = null;
          }
          await baileysLock.releaseLock(instanceId);

          const reason = loggedOut
            ? "Logout (401)"
            : replaced
              ? "Sessão substituída (440)"
              : code
                ? `Conexão fechada (code ${code})`
                : "Conexão fechada";

          const wasIntentional = inst._intentionalDisconnect;
          if (!wasIntentional) {
            log.warn(
              {
                instanceId,
                code,
                errMsg: errMsg.slice(0, 200),
                appEnv: ENV.APP_ENV,
                hostname: ENV.BAILEYS_HOSTNAME || require("os").hostname(),
                pid: process.pid,
              },
              `Baileys disconnect: ${reason}`,
            );
          }
          inst._intentionalDisconnect = false;

          if (loggedOut) {
            log.info({ instanceId }, "Logout detectado — limpando auth");
            await clearDbAuth(instanceId);
            inst.qrBase64 = null;
            inst._reconnectDelay = 8000;
            inst._genericDisconnectCount = 0;
            inst.manualReconnectRequired = false;
            if (!wasIntentional) maybeEmitBaileysDisconnected(inst, instanceId, reason);
          } else if (replaced) {
            inst.status = "conflict";
            inst._replaced440Count = (inst._replaced440Count || 0) + 1;
            inst.manualReconnectRequired = true;
            log.warn(
              {
                instanceId,
                appEnv: ENV.APP_ENV,
                hostname: ENV.BAILEYS_HOSTNAME || require("os").hostname(),
                pid: process.pid,
                owner: baileysLock.ownerId(),
                replaceCount: inst._replaced440Count,
                clearAuthOn440: ENV.BAILEYS_CLEAR_AUTH_ON_440,
              },
              "440 detected — sessão substituída. Possíveis causas: outro processo, prod+homolog no mesmo banco, WEB_CONCURRENCY>1. Conecte manualmente no painel.",
            );
            if (ENV.BAILEYS_CLEAR_AUTH_ON_440) {
              await clearDbAuth(instanceId);
              log.info({ instanceId }, "440 → auth limpo (BAILEYS_CLEAR_AUTH_ON_440). Próximo Conectar exige novo QR.");
            } else {
              log.info(
                { instanceId },
                "Auth mantido. Use Conectar no painel para retentar. Se 440 persiste: verifique APP_ENV, processos duplicados, ou BAILEYS_CLEAR_AUTH_ON_440=true.",
              );
            }
            if (!wasIntentional) maybeEmitBaileysDisconnected(inst, instanceId, reason);
          } else {
            if (wasIntentional) {
              inst._replaced440Count = 0;
              inst._genericDisconnectCount = 0;
              log.info(
                { instanceId, code },
                "Baileys: desconexão intencional — sem reconexão automática",
              );
              return;
            }
            inst._replaced440Count = 0;
            inst._genericDisconnectCount = (inst._genericDisconnectCount || 0) + 1;
            if (inst._genericDisconnectCount > MAX_AUTO_RECONNECT_ATTEMPTS) {
              inst.manualReconnectRequired = true;
              log.error(
                {
                  instanceId,
                  attempts: inst._genericDisconnectCount,
                  code,
                },
                "Baileys: limite de reconexões automáticas excedido — exige Conectar manual no painel",
              );
              if (!wasIntentional) {
                maybeEmitBaileysDisconnected(
                  inst,
                  instanceId,
                  `${reason} — reconexão automática pausada após ${MAX_AUTO_RECONNECT_ATTEMPTS} tentativas. Use "Conectar" no painel.`,
                  { force: true },
                );
              }
              return;
            }
            if (!wasIntentional) maybeEmitBaileysDisconnected(inst, instanceId, reason);
            const delayMs = backoffMsForAttempt(inst._genericDisconnectCount);
            inst._reconnectDelay = delayMs;
            log.info(
              { instanceId, code, attempt: inst._genericDisconnectCount, delaySec: delayMs / 1000 },
              "Conexão fechada — uma nova tentativa agendada (backoff)",
            );
            scheduleReconnect(instanceId, delayMs);
          }
        }
      } catch (err) {
        log.error({ err, instanceId, connection }, "Erro em connection.update");
      }
    });
  } catch (err) {
    inst.starting = false;
    inst.status = "disconnected";
    inst.socket = null;
    log.error({ instanceId, err: err?.message }, "Baileys: erro ao iniciar socket");
    try {
      await baileysLock.releaseLock(instanceId);
    } catch (e) {
      log.warn({ instanceId, err: e?.message }, "releaseLock após falha no start");
    }
    if (!inst.manualReconnectRequired) {
      inst._genericDisconnectCount = (inst._genericDisconnectCount || 0) + 1;
      if (inst._genericDisconnectCount > MAX_AUTO_RECONNECT_ATTEMPTS) {
        inst.manualReconnectRequired = true;
        log.error({ instanceId }, "Baileys: limite de tentativas após erro no start — reconexão manual");
        maybeEmitBaileysDisconnected(
          inst,
          instanceId,
          `Falha ao iniciar Baileys (${err?.message || "erro"}). Reconexão manual necessária no painel.`,
          { force: true },
        );
        return;
      }
      const delayMs = backoffMsForAttempt(inst._genericDisconnectCount);
      scheduleReconnect(instanceId, delayMs);
    }
  }
}

// Proteção: evita initAll duplicado em processo
let _initInProgress = false;
let _initDone = false;

async function initAll() {
  const ENV = require("../config/env");
  if (!ENV.BAILEYS_ENABLED) {
    log.info("Baileys desabilitado (BAILEYS_ENABLED=false)");
    return;
  }
  if (_initInProgress) {
    log.warn("initAll já em andamento — ignorando chamada duplicada");
    return;
  }
  if (_initDone) {
    log.warn("initAll já executado neste processo — ignorando");
    return;
  }
  _initInProgress = true;

  try {
    const socketService = require("./socket.service");
    if (!socketService.getIO()) {
      // Normal em `src/bootstrap/baileys.js` (processo só QR). Em monólito, index.js inicia Socket antes de runStartup.
      log.info(
        "Baileys: Socket.IO não está neste processo — esperado no worker dedicado; painel em tempo real depende do serviço web ou monólito (node index.js).",
      );
    }
  } catch {}

  const concurrency = ENV.WEB_CONCURRENCY || 1;
  if (concurrency > 1) {
    log.warn(
      { WEB_CONCURRENCY: concurrency },
      "Baileys: WEB_CONCURRENCY>1 causa 440 (sessão substituída). Defina WEB_CONCURRENCY=1.",
    );
  }

  const authIds = await listInstances();

  const env = ENV.APP_ENV || "local";
  const instancePrefix = `baileys:instance:${env}:`;
  const cfgs = await prisma.config.findMany({
    where: { key: { startsWith: instancePrefix } },
    select: { key: true },
  });
  const cfgIds = cfgs.map((c) => c.key.replace(instancePrefix, ""));

  const ids = [...new Set([...authIds, ...cfgIds, "default"])];

  for (const id of ids) {
    try {
      await start(id);
    } catch (err) {
      log.error({ instanceId: id, err }, "[Baileys:initAll] erro ao iniciar instância");
    }
  }
  _initInProgress = false;
  _initDone = true;
  log.info({ instances: ids }, "Baileys initAll concluído");
}

// ── Envio ──────────────────────────────────────────────────────
// saveHistory=true: salva no chatMemory (usado por notificações/broadcast diretos)
// saveHistory=false: não salva (bot handler já chama chatMemory.push internamente)
async function sendText(to, text, instanceId = "default", skipNotifyCheck = false, saveHistory = true) {
  const inst = INSTANCES.get(instanceId);
  if (!inst || !inst.socket || inst.status !== "connected") {
    return { ok: false, error: "instance_not_connected" };
  }

  if (!skipNotifyCheck && inst.notifyTo.length > 0 && !inst.notifyTo.includes(to)) {
    console.warn(`[Baileys:${instanceId}] Envio bloqueado para ${to} — não está na lista.`);
    return { ok: false, error: "number_not_allowed" };
  }

  if (!checkLimits(inst)) {
    log.warn({ instanceId, to, lastAlert: inst.lastAlert }, "Envio bloqueado: limite atingido");
    return { ok: false, error: "limit_reached" };
  }

  try {
    const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
    const sent = await inst.socket.sendMessage(jid, { text });

    inst.counters.hour++;
    inst.counters.day++;

    if (saveHistory) {
      try {
        const botHandler = require("../routes/bot.handler");
        const PhoneNormalizer = require("../normalizers/PhoneNormalizer");
        const dest = String(to);
        const tenantId = dest.includes("@lid")
          ? await detectTenantForInbound({ phoneDigits: null, remoteJid: dest }, instanceId)
          : await detectTenantByPhone(dest.split("@")[0].replace(/\D/g, ""), instanceId);

        if (tenantId) {
          let customer = null;
          if (dest.includes("@lid")) {
            customer = await prisma.customer.findFirst({ where: { tenantId, waId: dest } });
          } else {
            const normalized =
              PhoneNormalizer.normalize(dest.split("@")[0]) || dest.split("@")[0].replace(/\D/g, "");
            customer = await prisma.customer.findUnique({
              where: { tenantId_phone: { tenantId, phone: normalized } },
            });
          }
          await botHandler.saveBaileysMessage(dest, text, tenantId, "assistant", sent?.key?.id || null, {
            customerId: customer?.id,
          });
        }
      } catch (err) {
        log.warn({ instanceId, err: err?.message }, "Erro ao registrar msg outbound no histórico");
      }
    }

    return {
      ok: true,
      messageId: sent?.key?.id || null,
      key: sent?.key || null,
    };
  } catch (err) {
    log.error({ instanceId, to, err }, "Erro ao enviar mensagem");
    return { ok: false, error: err.message || "send_failed" };
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
      where: { key: instanceConfigKey(instanceId) },
    });
    if (cfg?.value) {
      const { tenantId } = JSON.parse(cfg.value);
      return tenantId || null;
    }
  } catch {}
  return null;
}

/** Mescla JSON em `baileys:instance:{env}:{id}` preservando tenantId e botEnabled. */
async function mergeInstanceConfig(instanceId, patch) {
  const key = instanceConfigKey(instanceId);
  let base = { tenantId: null };
  const row = await prisma.config.findUnique({ where: { key } });
  if (row?.value) {
    try {
      base = { ...base, ...JSON.parse(row.value) };
    } catch {}
  }
  const next = { ...base, ...patch };
  await prisma.config.upsert({
    where: { key },
    create: { key, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
  return next;
}

async function setInstanceTenant(instanceId, tenantId) {
  await mergeInstanceConfig(instanceId, { tenantId: tenantId || null });
}

/** Aplica botEnabled salvo no banco (se existir). Default em memória continua true. */
async function applyInstancePrefsFromDb(instanceId, inst) {
  try {
    const cfg = await prisma.config.findUnique({
      where: { key: instanceConfigKey(instanceId) },
    });
    if (!cfg?.value) return;
    const j = JSON.parse(cfg.value);
    if (typeof j.botEnabled === "boolean") inst.botEnabled = j.botEnabled;
  } catch {}
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
    manualReconnectRequired: !!inst.manualReconnectRequired,
    reconnectAttempts: inst._genericDisconnectCount || 0,
    usage: {
      hour: inst.counters.hour,
      hourMax: LIMITS.perHour,
      day: inst.counters.day,
      dayMax: LIMITS.perDay,
    },
  };
}

async function setBotEnabled(instanceId = "default", enabled) {
  const on = !!enabled;
  const inst = INSTANCES.get(instanceId);
  if (inst) inst.botEnabled = on;
  await mergeInstanceConfig(instanceId, { botEnabled: on });
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

async function disconnect(instanceId = "default") {
  const inst = INSTANCES.get(instanceId);
  if (!inst) return;
  inst.starting = false;
  inst._intentionalDisconnect = true;
  inst._replaced440Count = 0;
  inst._genericDisconnectCount = 0;
  inst.manualReconnectRequired = false;
  inst._socketEpoch = (inst._socketEpoch || 0) + 1;
  if (inst._reconnectTimer) {
    clearTimeout(inst._reconnectTimer);
    inst._reconnectTimer = null;
  }
  if (inst._heartbeatInterval) {
    clearInterval(inst._heartbeatInterval);
    inst._heartbeatInterval = null;
  }
  destroyLivingSocket(inst, "intentional_disconnect");
  await baileysLock.releaseLock(instanceId);
  await clearDbAuth(instanceId).catch(() => {});
  inst.status = "disconnected";
  inst.socket = null;
  inst.qrBase64 = null;
  if (instanceId !== "default") INSTANCES.delete(instanceId);
}

/** Remove a instância do registro (config + memória). Usado pelo botão Excluir no painel. */
async function removeInstance(instanceId = "default") {
  if (instanceId === "default") {
    await disconnect("default");
    return;
  }
  await disconnect(instanceId);
  try {
    await prisma.config.deleteMany({ where: { key: instanceConfigKey(instanceId) } });
  } catch (e) {
    log.warn({ instanceId, err: e?.message }, "removeInstance: falha ao apagar config da instância");
  }
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

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function broadcastSend(numbers, message, instanceId = "default", delayMs = 5000) {
  const normalized = numbers.map((n) => String(n || "").replace(/\D/g, "")).filter((n) => n.length >= 10);
  const unique = [...new Set(normalized)];
  const results = { sent: 0, failed: 0, errors: [] };

  for (const phone of unique) {
    try {
      const r = await sendText(phone, message, instanceId, true);
      if (r?.ok) results.sent++;
      else {
        results.failed++;
        results.errors.push({ phone, error: "Falha ao enviar" });
      }
    } catch (err) {
      results.failed++;
      results.errors.push({ phone, error: err.message || "Erro" });
    }
    if (delayMs > 0) await delay(delayMs);
  }

  return results;
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
  removeInstance,
  getProfilePicture,
  getReplyChannel,
  setReplyChannel,
  broadcastSend,
};
