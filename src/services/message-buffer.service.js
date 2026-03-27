// src/services/message-buffer.service.js
// Buffer em memória por (tenantId + phone + channel) para evitar resposta no meio de mensagens fragmentadas.
// Janela padrão: 1500ms | Interações (botão/lista/localização): ~400ms.

const log = require("../lib/logger").child({ service: "message-buffer" });

const DEFAULT_WINDOW_MS = 1500;
const FAST_WINDOW_MS = 400;
const DEFAULT_MAX_WAIT_MS = 3500;

/** key -> { items: [], timer, maxWaitTimer, flushing, openedAt, windowMs, maxWaitMs, onFlush } */
const buffers = new Map();

function buildKey({ tenantId, phone, channel }) {
  return `${tenantId}::${phone}::${channel || "default"}`;
}

function normalizeText(v) {
  if (v == null) return "";
  if (typeof v !== "string") return String(v);
  return v;
}

function mergeBatch(items) {
  const texts = items.map((i) => normalizeText(i.text).trim()).filter(Boolean);
  const combinedText = texts.join("\n").trim();
  const last = items[items.length - 1] || {};
  return {
    combinedText,
    lastMeta: last.meta || null,
    count: items.length,
  };
}

function scheduleDebounceFlush(key, entry) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    flushBuffer(key, entry, "debounce").catch((err) => {
      log.error({ err, key }, "Falha no flush debounce");
    });
  }, entry.windowMs);
}

function scheduleMaxWaitFlush(key, entry) {
  if (entry.maxWaitTimer) return;
  const elapsed = Date.now() - (entry.openedAt || Date.now());
  const remaining = Math.max(0, entry.maxWaitMs - elapsed);
  entry.maxWaitTimer = setTimeout(() => {
    flushBuffer(key, entry, "max_wait").catch((err) => {
      log.error({ err, key }, "Falha no flush max_wait");
    });
  }, remaining);
}

async function flushBuffer(key, entry, reason) {
  if (!entry) return;
  if (entry.flushing) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (entry.maxWaitTimer) {
    clearTimeout(entry.maxWaitTimer);
    entry.maxWaitTimer = null;
  }
  if (!entry.items.length) {
    buffers.delete(key);
    return;
  }

  entry.flushing = true;
  const batch = entry.items.splice(0, entry.items.length);
  try {
    const merged = mergeBatch(batch);
    if (typeof entry.onFlush === "function") await entry.onFlush(merged);
  } catch (err) {
    const [tenantId, phone, channel] = key.split("::");
    log.error({ err, tenantId, phone, channel, reason }, "Falha ao flushar buffer");
  } finally {
    entry.flushing = false;
    // Se chegaram novas mensagens durante o flush, abre um novo ciclo de buffer.
    if (entry.items.length > 0) {
      entry.openedAt = Date.now();
      scheduleDebounceFlush(key, entry);
      scheduleMaxWaitFlush(key, entry);
    } else {
      buffers.delete(key);
    }
  }
}

function enqueue({ tenantId, phone, channel, text, meta, windowMs, onFlush }) {
  const key = buildKey({ tenantId, phone, channel });
  const win = Math.max(150, Math.min(DEFAULT_WINDOW_MS, windowMs || DEFAULT_WINDOW_MS));
  const maxWaitMs = Math.max(win, DEFAULT_MAX_WAIT_MS);

  let entry = buffers.get(key);
  if (!entry) {
    entry = {
      items: [],
      timer: null,
      maxWaitTimer: null,
      flushing: false,
      onFlush,
      openedAt: Date.now(),
      windowMs: win,
      maxWaitMs,
    };
    buffers.set(key, entry);
  }

  // atualiza callback se vier nova referência
  if (typeof onFlush === "function") entry.onFlush = onFlush;
  entry.windowMs = win;
  entry.maxWaitMs = maxWaitMs;
  if (!entry.openedAt) entry.openedAt = Date.now();

  entry.items.push({ text, meta: meta || null, at: Date.now() });
  scheduleDebounceFlush(key, entry);
  scheduleMaxWaitFlush(key, entry);
}

function decideWindowMs({ kind }) {
  if (!kind) return DEFAULT_WINDOW_MS;
  const k = String(kind).toLowerCase();
  if (k.includes("interactive") || k.includes("button") || k.includes("list") || k.includes("location")) return FAST_WINDOW_MS;
  return DEFAULT_WINDOW_MS;
}

module.exports = {
  enqueue,
  decideWindowMs,
  DEFAULT_WINDOW_MS,
  FAST_WINDOW_MS,
};

