// src/lib/whatsapp.js

const { withRetry } = require("./retry");
const WA_BASE = "https://graph.facebook.com/v19.0";

/**
 * @param {string | { to?: string, recipientUserId?: string }} destination
 * @returns {Record<string, unknown>}
 */
function recipientBlock(destination) {
  if (destination != null && typeof destination === "object" && !Array.isArray(destination)) {
    const uid = destination.recipientUserId != null ? String(destination.recipientUserId).trim() : "";
    if (uid) return { recipient: { user_id: uid } };
    const toObj = destination.to != null ? String(destination.to).replace(/\D/g, "") : "";
    if (toObj) return { to: toObj };
    throw new Error("WhatsApp Cloud: recipientUserId ou to ausente no objeto de destino.");
  }
  const to = destination != null ? String(destination).replace(/\D/g, "") : "";
  if (to) return { to };
  throw new Error(
    "WhatsApp Cloud: sem destino válido — informe número (to) ou BSUID ({ recipientUserId: 'XX.yyy' }).",
  );
}

function createClient({ token, phoneNumberId }) {
  if (!token) throw new Error("WhatsApp: token não configurado");
  if (!phoneNumberId) throw new Error("WhatsApp: phoneNumberId não configurado");

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const url = `${WA_BASE}/${phoneNumberId}/messages`;

  async function post(payload) {
    return withRetry(
      async () => {
        const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
        if (!resp.ok) {
          const data = await resp.json().catch(() => null);
          const err = new Error(`WA API ${resp.status}: ${JSON.stringify(data)}`);
          err.status = resp.status;
          throw err;
        }
        return resp.json();
      },
      { maxAttempts: 3, baseDelayMs: 800, label: `WA:${phoneNumberId}` },
    );
  }

  return {
    sendText(destination, text, previewUrl = false) {
      const r = recipientBlock(destination);
      return post({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        ...r,
        type: "text",
        text: { body: text, preview_url: previewUrl },
      });
    },
    sendButtons(destination, body, buttons) {
      const r = recipientBlock(destination);
      return post({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        ...r,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: body },
          action: {
            buttons: buttons.map((b, i) => ({ type: "reply", reply: { id: b.id || String(i), title: b.title } })),
          },
        },
      });
    },
    sendList(destination, header, body, footer, sections) {
      const r = recipientBlock(destination);
      return post({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        ...r,
        type: "interactive",
        interactive: {
          type: "list",
          header: { type: "text", text: header },
          body: { text: body },
          footer: { text: footer },
          action: { button: "Ver opções", sections },
        },
      });
    },
    sendTemplate(destination, name, language = "pt_BR", components = []) {
      const r = recipientBlock(destination);
      return post({
        messaging_product: "whatsapp",
        ...r,
        type: "template",
        template: { name, language: { code: language }, components },
      });
    },
    markRead(messageId, withTyping = false) {
      const payload = {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      };
      if (withTyping) payload.typing_indicator = { type: "text" };
      return post(payload);
    },
    async getTemplates() {
      const wabaId = await getWabaId(token, phoneNumberId);
      if (!wabaId) throw new Error("Não foi possível obter o WABA ID");
      const res = await fetch(`${WA_BASE}/${wabaId}/message_templates?status=APPROVED`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Erro ao buscar templates: " + (await res.text()));
      const data = await res.json();
      return data.data || [];
    },
    async getMediaUrl(mediaId) {
      const res = await fetch(`${WA_BASE}/${mediaId}`, { headers });
      if (!res.ok) return null;
      const data = await res.json();
      return data.url;
    },
    sendImage(destination, url, caption = "") {
      const r = recipientBlock(destination);
      return post({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        ...r,
        type: "image",
        image: { link: url, caption },
      });
    },
    sendAudio(destination, url) {
      const r = recipientBlock(destination);
      return post({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        ...r,
        type: "audio",
        audio: { link: url },
      });
    },
    sendDocument(destination, url, filename = "documento.pdf") {
      const r = recipientBlock(destination);
      return post({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        ...r,
        type: "document",
        document: { link: url, filename },
      });
    },
  };
}

async function getWabaId(token, phoneNumberId) {
  const res = await fetch(`${WA_BASE}/${phoneNumberId}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const data = await res.json();
  return data.whatsapp_business_account_id;
}

module.exports = { createClient, recipientBlock };
