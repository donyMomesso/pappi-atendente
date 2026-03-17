// src/lib/whatsapp.js
// Cliente WhatsApp Cloud API (Meta)

const { withRetry } = require("./retry");

const WA_BASE = "https://graph.facebook.com/v19.0";

/**
 * Cria um cliente WhatsApp para um número específico.
 *
 * @param {object} config
 * @param {string} config.token         Bearer token do WABA
 * @param {string} config.phoneNumberId ID do número de telefone
 * @returns {object}  Cliente com métodos de envio
 */
function createClient({ token, phoneNumberId }) {
  if (!token) throw new Error("WhatsApp: token não configurado");
  if (!phoneNumberId) throw new Error("WhatsApp: phoneNumberId não configurado");

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const url = `${WA_BASE}/${phoneNumberId}/messages`;

  async function post(payload) {
    return withRetry(
      async () => {
        const resp = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });
        if (!resp.ok) {
          const data = await resp.json().catch(() => null);
          const err = new Error(`WA API ${resp.status}: ${JSON.stringify(data)}`);
          err.status = resp.status;
          throw err;
        }
        return resp.json();
      },
      { maxAttempts: 3, baseDelayMs: 800, label: `WA:${phoneNumberId}` }
    );
  }

  return {
    /** Envia mensagem de texto */
    sendText(to, text, previewUrl = false) {
      return post({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { body: text, preview_url: previewUrl },
      });
    },

    /** Envia mensagem interativa com botões */
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
            buttons: buttons.map((b, i) => ({
              type: "reply",
              reply: { id: b.id || String(i), title: b.title },
            })),
          },
        },
      });
    },

    /** Envia lista interativa */
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

    /** Envia template */
    sendTemplate(to, name, language = "pt_BR", components = []) {
      return post({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: { name, language: { code: language }, components },
      });
    },

    /** Marca mensagem como lida */
    markRead(messageId) {
      return post({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      });
    },
  };
}

module.exports = { createClient };
