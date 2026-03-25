// src/services/message-buffer.service.js
// Buffer em memória por (tenantId + phone + channel) para evitar resposta no meio de mensagens fragmentadas.
// Janela padrão: 2500ms | Interações (botão/lista/localização): ~400ms.

const log = require("../lib/logger").child({ service: "message-buffer" });

const DEFAULT_WINDOW_MS = 2500;
const FAST_WINDOW_MS = 400;

/** key -> { items: [], timer, flushing } */
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

function enqueue({ tenantId, phone, channel, text, meta, windowMs, onFlush }) {
  const key = buildKey({ tenantId, phone, channel });
  const win = Math.max(150, Math.min(DEFAULT_WINDOW_MS, windowMs || DEFAULT_WINDOW_MS));

  let entry = buffers.get(key);
  if (!entry) {
    entry = { items: [], timer: null, flushing: false, onFlush };
    buffers.set(key, entry);
  }

  // atualiza callback se vier nova referência
  if (typeof onFlush === "function") entry.onFlush = onFlush;

  entry.items.push({ text, meta: meta || null, at: Date.now() });

  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(async () => {
    if (entry.flushing) return; // já existe flush em andamento
    entry.flushing = true;
    const batch = entry.items.splice(0, entry.items.length);
    try {
      const merged = mergeBatch(batch);
      if (typeof entry.onFlush === "function") await entry.onFlush(merged);
    } catch (err) {
      log.error({ err, tenantId, phone, channel }, "Falha ao flushar buffer");
    } finally {
      entry.flushing = false;
      // remove buffer vazio
      if (entry.items.length === 0) buffers.delete(key);
    }
  }, win);
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

