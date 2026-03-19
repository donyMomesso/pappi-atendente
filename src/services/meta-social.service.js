// src/services/meta-social.service.js
// Integração com Instagram DM e Facebook Messenger

const ENV = require("../config/env");

const GRAPH = "https://graph.facebook.com/v19.0";

/**
 * Envia mensagem via Instagram DM
 */
async function sendInstagram(recipientId, text) {
  if (!ENV.FACEBOOK_PAGE_TOKEN || !ENV.INSTAGRAM_PAGE_ID) return null;
  try {
    const res = await fetch(`${GRAPH}/${ENV.INSTAGRAM_PAGE_ID}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ENV.FACEBOOK_PAGE_TOKEN}`,
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

/**
 * Envia mensagem via Facebook Messenger
 */
async function sendFacebook(recipientId, text) {
  if (!ENV.FACEBOOK_PAGE_TOKEN || !ENV.FACEBOOK_PAGE_ID) return null;
  try {
    const res = await fetch(`${GRAPH}/${ENV.FACEBOOK_PAGE_ID}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ENV.FACEBOOK_PAGE_TOKEN}`,
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

/**
 * Detecta a origem do webhook (instagram ou facebook) e extrai mensagens
 * Retorna array de { platform, senderId, text, timestamp }
 */
function parseWebhook(body) {
  const messages = [];
  const entries = body.entry || [];

  for (const entry of entries) {
    // Instagram
    if (entry.changes) {
      for (const change of entry.changes) {
        if (change.field !== "messages") continue;
        const val = change.value;
        if (!val.messages) continue;
        for (const msg of val.messages) {
          if (msg.type !== "text") continue;
          messages.push({
            platform: "instagram",
            senderId: msg.from?.id || val.sender?.id,
            senderName: val.contacts?.[0]?.profile?.name || null,
            text: msg.text?.body || "",
            timestamp: msg.timestamp,
          });
        }
      }
    }

    // Facebook Messenger
    if (entry.messaging) {
      for (const event of entry.messaging) {
        if (!event.message?.text) continue;
        messages.push({
          platform: "facebook",
          senderId: event.sender?.id,
          senderName: null,
          text: event.message.text,
          timestamp: event.timestamp,
        });
      }
    }
  }

  return messages;
}

module.exports = { sendInstagram, sendFacebook, parseWebhook };
