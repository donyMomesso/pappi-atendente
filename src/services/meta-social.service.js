// src/services/meta-social.service.js

const ENV = require("../config/env");
const prisma = require("../lib/db");

const GRAPH = "https://graph.facebook.com/v19.0";

async function getTenantSocialConfig(tenantId) {
  const keys = [
    `${tenantId}:facebook_page_id`,
    `${tenantId}:instagram_page_id`,
    `${tenantId}:facebook_page_token`,
  ];

  const rows = await prisma.config.findMany({
    where: { key: { in: keys } },
    select: { key: true, value: true },
  });

  const map = Object.fromEntries(rows.map((r) => [r.key, (r.value || "").trim()]));

  return {
    facebookPageId: map[`${tenantId}:facebook_page_id`] || ENV.FACEBOOK_PAGE_ID || "",
    instagramPageId: map[`${tenantId}:instagram_page_id`] || ENV.INSTAGRAM_PAGE_ID || "",
    pageToken: map[`${tenantId}:facebook_page_token`] || ENV.FACEBOOK_PAGE_TOKEN || "",
  };
}

async function resolveTenantId({ platform, recipientId, senderId }) {
  const socialId = `${platform}:${senderId}`;

  const existingCustomer = await prisma.customer.findFirst({
    where: { phone: socialId },
    select: { tenantId: true },
  });

  if (existingCustomer?.tenantId) return existingCustomer.tenantId;

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
    return key.replace(/:facebook_page_id$/, "").replace(/:instagram_page_id$/, "");
  }

  const fallbackTenant = await prisma.tenant.findFirst({
    where: { active: true },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  return fallbackTenant?.id || null;
}

async function sendInstagram(recipientId, text, tenantId) {
  if (!recipientId || !text || !tenantId) return null;

  const cfg = await getTenantSocialConfig(tenantId);
  if (!cfg.pageToken || !cfg.instagramPageId) return null;

  try {
    const res = await fetch(`${GRAPH}/${cfg.instagramPageId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.pageToken}`,
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text },
        messaging_type: "RESPONSE",
      }),
    });

    return await res.json();
  } catch (err) {
    console.error("[Meta:Instagram] Erro ao enviar:", err.message);
    return null;
  }
}

async function sendFacebook(recipientId, text, tenantId) {
  if (!recipientId || !text || !tenantId) return null;

  const cfg = await getTenantSocialConfig(tenantId);
  if (!cfg.pageToken || !cfg.facebookPageId) return null;

  try {
    const res = await fetch(`${GRAPH}/${cfg.facebookPageId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.pageToken}`,
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text },
        messaging_type: "RESPONSE",
      }),
    });

    return await res.json();
  } catch (err) {
    console.error("[Meta:Facebook] Erro ao enviar:", err.message);
    return null;
  }
}

function parseInstagramWebhook(body) {
  const out = [];

  for (const entry of body.entry || []) {
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
        const attachmentType = msg?.attachments?.[0]?.type || null;

        const senderId = String(value.sender?.id || msg?.from?.id || msg?.from || "");
        if (!senderId) continue;

        out.push({
          platform: "instagram",
          senderId,
          recipientId,
          senderName: value.contacts?.[0]?.profile?.name || null,
          text,
          attachmentType,
          timestamp: value.timestamp || msg?.timestamp || entry?.time || Date.now(),
        });
      }
    }
  }

  return out.filter((m) => m.senderId && (m.text || m.attachmentType));
}

function parseFacebookWebhook(body) {
  const out = [];

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const rawText = event.message?.text ?? "";
      const text = typeof rawText === "string" ? rawText.trim() : "";
      const attachmentType = event.message?.attachments?.[0]?.type || null;

      const senderId = String(event.sender?.id || "");
      if (!senderId) continue;

      out.push({
        platform: "facebook",
        senderId,
        recipientId: String(event.recipient?.id || ""),
        senderName: null,
        text,
        attachmentType,
        timestamp: event.timestamp || entry?.time || Date.now(),
      });
    }
  }

  return out.filter((m) => m.senderId && (m.text || m.attachmentType));
}

function parseWebhook(body) {
  if (body.object === "instagram") return parseInstagramWebhook(body);
  if (body.object === "page") return parseFacebookWebhook(body);
  return [];
}

module.exports = {
  sendInstagram,
  sendFacebook,
  parseWebhook,
  resolveTenantId,
  getTenantSocialConfig,
};