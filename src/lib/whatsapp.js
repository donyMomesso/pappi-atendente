// src/lib/whatsapp.js

const { withRetry } = require("./retry");
const WA_BASE = "https://graph.facebook.com/v19.0";

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
    sendText(to, text, previewUrl = false) {
      return post({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { body: text, preview_url: previewUrl },
      });
    },
    sendButtons(to, body, buttons) {
      return post({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
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
    sendList(to, header, body, footer, sections) {
      return post({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
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
    sendTemplate(to, name, language = "pt_BR", components = []) {
      return post({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: { name, language: { code: language }, components },
      });
    },
    markRead(messageId) {
      return post({ messaging_product: "whatsapp", status: "read", message_id: messageId });
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
    sendImage(to, url, caption = "") {
      return post({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "image",
        image: { link: url, caption },
      });
    },
    sendAudio(to, url) {
      return post({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "audio",
        audio: { link: url },
      });
    },
    sendDocument(to, url, filename = "documento.pdf") {
      return post({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
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

module.exports = { createClient };
