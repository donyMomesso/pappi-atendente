// src/services/meta-social.service.js

const ENV = require("../config/env");
const prisma = require("../lib/db");
const log = require("../lib/logger").child({ service: "meta-social" });
const metaTelemetry = require("../lib/meta-telemetry");

const GRAPH = "https://graph.facebook.com/v19.0";

async function getTenantSocialConfig(tenantId) {
  const keys = [
    `${tenantId}:facebook_page_id`,
    `${tenantId}:instagram_page_id`,
    `${tenantId}:facebook_page_token`,
    `${tenantId}:instagram_page_token`,
  ];

  const rows = await prisma.config.findMany({
    where: { key: { in: keys } },
    select: { key: true, value: true },
  });

  const map = Object.fromEntries(rows.map((r) => [r.key, (r.value || "").trim()]));
  const fbToken = map[`${tenantId}:facebook_page_token`] || ENV.FACEBOOK_PAGE_TOKEN || "";
  const igToken = map[`${tenantId}:instagram_page_token`] || ENV.INSTAGRAM_PAGE_TOKEN || fbToken;

  return {
    facebookPageId: map[`${tenantId}:facebook_page_id`] || ENV.FACEBOOK_PAGE_ID || "",
    instagramPageId: map[`${tenantId}:instagram_page_id`] || ENV.INSTAGRAM_PAGE_ID || "",
    facebookPageToken: fbToken,
    instagramPageToken: igToken,
    pageToken: fbToken, // fallback legado
  };
}

function extractFirstAttachment(msg) {
  const a = msg?.attachments?.[0] || null;
  const type = a?.type && typeof a.type === "string" ? a.type : null;
  const url = a?.payload?.url && typeof a.payload.url === "string" ? a.payload.url : null;
  return { type, url };
}

async function resolveSenderName({ platform, senderId, tenantId }) {
  try {
    const cfg = await getTenantSocialConfig(tenantId);
    const token =
      platform === "instagram"
        ? (cfg.instagramPageToken || cfg.facebookPageToken || "").trim()
        : (cfg.facebookPageToken || "").trim();
    if (!token) return null;

    const res = await fetch(`${GRAPH}/${encodeURIComponent(String(senderId))}?fields=name`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const name = typeof data?.name === "string" ? data.name.trim() : "";
    return name || null;
  } catch {
    return null;
  }
}

async function resolveTenantId({ platform, recipientId, senderId }) {
  const socialId = `${platform}:${senderId}`;

  const existingCustomer = await prisma.customer.findFirst({
    where: { phone: socialId },
    select: { tenantId: true },
  });

  if (existingCustomer?.tenantId) return existingCustomer.tenantId;

  if (!recipientId || String(recipientId).trim() === "") {
    log.warn({ platform, senderId }, "Social: recipientId ausente, não é possível resolver tenant");
    return null;
  }

  const configs = await prisma.config.findMany({
    where: {
      OR: [
        { key: { endsWith: ":facebook_page_id" }, value: String(recipientId || "") },
        { key: { endsWith: ":instagram_page_id" }, value: String(recipientId || "") },
      ],
    },
    select: { key: true },
  });

  if (configs.length > 0) {
    const key = configs[0].key;
    const tenantId = key.replace(/:facebook_page_id$/, "").replace(/:instagram_page_id$/, "");
    log.debug({ platform, recipientId, tenantId }, "Social: tenant resolvido por recipientId (Config)");
    return tenantId;
  }

  log.warn(
    { platform, recipientId, senderId },
    "Social: recipientId não encontrado em Config, tenant não resolvido (evitando fallback)"
  );
  return null;
}

async function sendInstagram(recipientId, text, tenantId) {
  const txt = typeof text === "string" ? text.trim() : "";
  if (!recipientId || !txt || !tenantId) {
    log.debug({ hasRecipient: !!recipientId, hasText: !!txt, tenantId }, "Instagram: parâmetros insuficientes");
    return {
      error: true,
      code: "invalid_params",
      channel: "instagram",
      message: "recipientId, texto ou tenantId ausente",
    };
  }

  const cfg = await getTenantSocialConfig(tenantId);
  const pageId = (cfg.facebookPageId || cfg.instagramPageId || "").trim();
  if (!cfg.instagramPageToken || !pageId) {
    const message = !cfg.instagramPageToken
      ? "Token Instagram ausente (instagram_page_token ou facebook_page_token no tenant)"
      : "Page ID ausente (facebook_page_id ou instagram_page_id da página ligada ao Instagram)";
    log.warn(
      { tenantId, hasToken: !!cfg.instagramPageToken, hasPageId: !!pageId },
      "Instagram: config incompleta — envio não realizado",
    );
    metaTelemetry.recordInstagramError("missing_config");
    return { error: true, code: "missing_config", channel: "instagram", message };
  }

  try {
    const res = await fetch(`${GRAPH}/${pageId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.instagramPageToken}`,
      },
      body: JSON.stringify({
        recipient: { id: String(recipientId) },
        message: { text: txt },
        messaging_type: "RESPONSE",
      }),
    });

    let body;
    try {
      const raw = await res.text();
      body = raw ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : null;
    } catch {
      body = null;
    }

    if (!res.ok) {
      const errMsg = typeof body === "object" ? body?.error?.message || JSON.stringify(body) : String(body);
      metaTelemetry.recordInstagramError(errMsg);
      log.error(
        { channel: "instagram", tenantId, recipientId, status: res.status, body },
        "Instagram: falha HTTP ao enviar"
      );
      return { error: true, channel: "instagram", status: res.status, body };
    }

    if (typeof body === "object" && body?.error?.message) {
      metaTelemetry.recordInstagramError(body.error.message);
    }
    return body;
  } catch (err) {
    log.error({ recipientId, tenantId, err: err.message }, "Instagram: erro ao enviar");
    metaTelemetry.recordInstagramError(err.message);
    return { error: true, code: "exception", channel: "instagram", message: err.message };
  }
}

async function sendFacebook(recipientId, text, tenantId) {
  const txt = typeof text === "string" ? text.trim() : "";
  if (!recipientId || !txt || !tenantId) {
    log.debug({ hasRecipient: !!recipientId, hasText: !!txt, tenantId }, "Facebook: parâmetros insuficientes");
    return {
      error: true,
      code: "invalid_params",
      channel: "facebook",
      message: "recipientId, texto ou tenantId ausente",
    };
  }

  const cfg = await getTenantSocialConfig(tenantId);
  if (!cfg.facebookPageToken || !cfg.facebookPageId) {
    const message = !cfg.facebookPageToken
      ? "facebook_page_token ausente no tenant"
      : "facebook_page_id ausente no tenant";
    log.warn(
      { tenantId, hasToken: !!cfg.facebookPageToken, hasPageId: !!cfg.facebookPageId },
      "Facebook: config incompleta — envio não realizado",
    );
    metaTelemetry.recordFacebookError("missing_config");
    return { error: true, code: "missing_config", channel: "facebook", message };
  }

  try {
    const res = await fetch(`${GRAPH}/${cfg.facebookPageId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.facebookPageToken}`,
      },
      body: JSON.stringify({
        recipient: { id: String(recipientId) },
        message: { text: txt },
        messaging_type: "RESPONSE",
      }),
    });

    let body;
    try {
      const raw = await res.text();
      body = raw ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : null;
    } catch {
      body = null;
    }

    if (!res.ok) {
      const errMsg = typeof body === "object" ? body?.error?.message || JSON.stringify(body) : String(body);
      metaTelemetry.recordFacebookError(errMsg);
      log.error(
        { channel: "facebook", tenantId, recipientId, status: res.status, body },
        "Facebook: falha HTTP ao enviar"
      );
      return { error: true, channel: "facebook", status: res.status, body };
    }

    if (typeof body === "object" && body?.error?.message) {
      metaTelemetry.recordFacebookError(body.error.message);
    }
    return body;
  } catch (err) {
    log.error({ recipientId, tenantId, err: err.message }, "Facebook: erro ao enviar");
    metaTelemetry.recordFacebookError(err.message);
    return { error: true, code: "exception", channel: "facebook", message: err.message };
  }
}

function parseInstagramWebhook(body) {
  const out = [];

  for (const entry of body.entry || []) {
    // Formato baseado em entry.changes[] (webhooks antigos / alternativos)
    for (const change of entry.changes || []) {
      if (change.field !== "messages") continue;

      const value = change.value || {};
      const recipientId = String(value.recipient?.id || entry?.id || "");

      const single = value.message
        ? [
            {
              mid: value.message?.mid,
              text: value.message?.text,
              attachments: value.message?.attachments || [],
            },
          ]
        : [];

      const list = Array.isArray(value.messages) ? value.messages : [];
      const messages = [...single, ...list];

      for (const msg of messages) {
        const rawText =
          msg?.text?.body ?? msg?.text ?? (typeof msg?.text === "string" ? msg.text : "") ?? "";
        const text = typeof rawText === "string" ? rawText.trim() : "";
        const att = extractFirstAttachment(msg);
        const safeAttachment = att.type;

        const senderId = String(value.sender?.id || msg?.from?.id || msg?.from || "");
        if (!senderId) continue;

        out.push({
          platform: "instagram",
          senderId,
          recipientId,
          senderName: value.contacts?.[0]?.profile?.name || null,
          text,
          attachmentType: safeAttachment,
          attachmentUrl: att.url,
          timestamp: value.timestamp || msg?.timestamp || entry?.time || Date.now(),
        });
      }
    }

    // Formato entry.messaging[] (webhook real do Instagram, igual ao Facebook)
    for (const event of entry.messaging || []) {
      const rawText = event.message?.text ?? "";
      const text = typeof rawText === "string" ? rawText.trim() : "";
      const att = extractFirstAttachment(event.message);
      const safeAttachment = att.type;

      const senderId = String(event.sender?.id || "");
      if (!senderId) continue;

      out.push({
        platform: "instagram",
        senderId,
        recipientId: String(event.recipient?.id || entry?.id || ""),
        senderName: null,
        text,
        attachmentType: safeAttachment,
        attachmentUrl: att.url,
        timestamp: event.timestamp || entry?.time || Date.now(),
      });
    }
  }

  return out.filter((m) => m.senderId && (m.text || m.attachmentType || m.attachmentUrl));
}

function parseFacebookWebhook(body) {
  const out = [];

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const rawText = event.message?.text ?? "";
      const text = typeof rawText === "string" ? rawText.trim() : "";
      const att = extractFirstAttachment(event.message);
      const safeAttachment = att.type;

      const senderId = String(event.sender?.id || "");
      if (!senderId) continue;

      out.push({
        platform: "facebook",
        senderId,
        recipientId: String(event.recipient?.id || ""),
        senderName: null,
        text,
        attachmentType: safeAttachment,
        attachmentUrl: att.url,
        timestamp: event.timestamp || entry?.time || Date.now(),
      });
    }
  }

  return out.filter((m) => m.senderId && (m.text || m.attachmentType || m.attachmentUrl));
}

function parseWebhook(body) {
  if (!body || typeof body !== "object") {
    log.warn("Meta webhook: body inválido ou vazio");
    return [];
  }
  if (body.object === "instagram") return parseInstagramWebhook(body);
  if (body.object === "page") return parseFacebookWebhook(body);
  log.debug({ object: body.object }, "Meta webhook: object não tratado (ignorado)");
  return [];
}

module.exports = {
  sendInstagram,
  sendFacebook,
  parseWebhook,
  resolveTenantId,
  getTenantSocialConfig,
  resolveSenderName,
};