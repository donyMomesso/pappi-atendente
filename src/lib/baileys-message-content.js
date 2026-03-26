// src/lib/baileys-message-content.js
// Extração de texto/tipo a partir do proto Baileys (inclui wrappers aninhados).

const MAX_RAW_SNIPPET = 600;

/**
 * Desembrulha ephemeral / viewOnce / edited / documentWithCaption até chegar ao nó útil.
 * @param {Record<string, unknown>|null|undefined} m
 * @param {number} depth
 * @returns {Record<string, unknown>|null|undefined}
 */
function unwrapProtoMessage(m, depth = 0) {
  if (!m || depth > 12) return m;
  if (m.ephemeralMessage?.message) return unwrapProtoMessage(m.ephemeralMessage.message, depth + 1);
  if (m.viewOnceMessage?.message) return unwrapProtoMessage(m.viewOnceMessage.message, depth + 1);
  if (m.viewOnceMessageV2?.message) return unwrapProtoMessage(m.viewOnceMessageV2.message, depth + 1);
  if (m.documentWithCaptionMessage?.message)
    return unwrapProtoMessage(m.documentWithCaptionMessage.message, depth + 1);
  if (m.editedMessage?.message) return unwrapProtoMessage(m.editedMessage.message, depth + 1);
  return m;
}

const FLOW_IDS = new Set([
  "delivery",
  "takeout",
  "confirm_addr",
  "change_addr",
  "CONFIRMAR",
  "CANCELAR",
  "AVISE_ABERTURA",
  "HELP_HUMAN",
  "HELP_BOT",
  "FULFILLMENT_RETIRADA",
]);

function normalizeFlowAliases(text) {
  if (!text) return text;
  const t = String(text)
    .toLowerCase()
    .replace(/✅|✏️|❌/g, "")
    .trim();
  if (t === "corrigir") return "change_addr";
  if (t === "cancelar") return "CANCELAR";
  if (t === "confirmar" || t === "confirma") return "confirm_addr";
  return text;
}

function humanMediaFallback(primaryKey) {
  const map = {
    imageMessage: "📷 Imagem recebida",
    videoMessage: "🎬 Vídeo recebido",
    audioMessage: "🎤 Áudio recebido",
    documentMessage: "📎 Documento recebido",
    stickerMessage: "Figurinha recebida",
    contactMessage: "Contato recebido",
    contactsArrayMessage: "Contatos recebidos",
    locationMessage: "📍 Localização recebida",
    liveLocationMessage: "📍 Localização ao vivo recebida",
    reactionMessage: "Reação",
    protocolMessage: "Evento de protocolo (WhatsApp)",
    pollCreationMessage: "Enquete recebida",
    pollUpdateMessage: "Resposta de enquete",
    buttonsResponseMessage: null,
    listResponseMessage: null,
    templateButtonReplyMessage: null,
  };
  return map[primaryKey] || `Mensagem recebida (${primaryKey || "desconhecido"})`;
}

/**
 * @param {{ message?: Record<string, unknown> | null }} msg
 * @returns {{
 *   displayText: string,
 *   mediaType: string,
 *   primaryKey: string | null,
 *   shouldInvokeBot: boolean,
 *   unknownKeys: string[],
 *   parseNote: string | null,
 *   rawSnippet: string | null,
 * }}
 */
function parseBaileysMessageContent(msg) {
  const root = msg?.message;
  const unknownKeys = root && typeof root === "object" ? Object.keys(root) : [];
  let parseNote = null;
  let rawSnippet = null;

  if (!root || typeof root !== "object") {
    return {
      displayText: "[Mensagem sem payload]",
      mediaType: "empty",
      primaryKey: null,
      shouldInvokeBot: false,
      unknownKeys,
      parseNote: "no_message_object",
      rawSnippet: null,
    };
  }

  const m = unwrapProtoMessage(root);
  const keys = Object.keys(m);
  const primaryKey = keys.length === 1 ? keys[0] : keys[0] || null;

  // protocolMessage (revoke, ephemeral setting, etc.)
  if (m.protocolMessage) {
    const pm = m.protocolMessage;
    const t = pm.type != null ? String(pm.type) : "";
    let text = "Evento de protocolo (WhatsApp)";
    if (t.includes("REVOKE") || t === "3") text = "Mensagem apagada";
    return {
      displayText: text,
      mediaType: "protocol",
      primaryKey: "protocolMessage",
      shouldInvokeBot: false,
      unknownKeys: keys,
      parseNote: t || "protocol",
      rawSnippet: null,
    };
  }

  let text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    null;

  if (!text && m.buttonsResponseMessage) {
    const btn = m.buttonsResponseMessage;
    const id = btn.selectedButtonId || "";
    const display = btn.selectedDisplayText || "";
    text = FLOW_IDS.has(String(id)) ? id : display || id || "";
  }

  if (!text && m.listResponseMessage) {
    const lr = m.listResponseMessage;
    text = lr.singleSelectReply?.selectedRowId || lr.title || lr.description || "";
  }

  if (!text && m.templateButtonReplyMessage) {
    const tb = m.templateButtonReplyMessage;
    text = tb.selectedDisplayText || tb.selectedId || "";
  }

  if (!text && m.reactionMessage) {
    const react = m.reactionMessage?.text || m.reactionMessage?.reaction || "❤";
    text = `Reação: ${react}`;
  }

  const mediaFirstKeys = [
    "imageMessage",
    "videoMessage",
    "audioMessage",
    "documentMessage",
    "stickerMessage",
    "contactMessage",
    "contactsArrayMessage",
    "locationMessage",
    "liveLocationMessage",
    "pollCreationMessage",
    "pollUpdateMessage",
  ];

  let mediaType = "text";
  if (m.imageMessage) mediaType = "image";
  else if (m.videoMessage) mediaType = "video";
  else if (m.audioMessage) mediaType = "audio";
  else if (m.documentMessage) mediaType = "document";
  else if (m.stickerMessage) mediaType = "sticker";
  else if (m.contactMessage || m.contactsArrayMessage) mediaType = "contact";
  else if (m.locationMessage || m.liveLocationMessage) mediaType = "location";
  else if (m.reactionMessage) mediaType = "reaction";
  else if (m.buttonsResponseMessage) mediaType = "buttons_reply";
  else if (m.listResponseMessage) mediaType = "list_reply";
  else if (m.templateButtonReplyMessage) mediaType = "template_reply";

  const hadUserText = !!(m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption);
  const hadInteractiveText = !!(
    m.buttonsResponseMessage ||
    m.listResponseMessage ||
    m.templateButtonReplyMessage
  );

  if (!text) {
    if (mediaFirstKeys.includes(primaryKey)) {
      text = humanMediaFallback(primaryKey);
      parseNote = "media_fallback";
    } else if (keys.length) {
      text = `[Conteúdo não mapeado: ${keys.join(",")}]`;
      parseNote = "unknown_message_type";
      try {
        rawSnippet = JSON.stringify(m).slice(0, MAX_RAW_SNIPPET);
      } catch {
        rawSnippet = null;
      }
    } else {
      text = "[Mensagem vazia]";
      parseNote = "empty_keys";
    }
  }

  text = normalizeFlowAliases(text);
  const displayText = String(text).trim() || "[Mensagem vazia]";

  // Só dispara o bot quando há texto/caption do usuário ou resposta estruturada (botões/lista/template).
  // Mídia só com fallback, reações, protocolo e tipos desconhecidos: persiste + UI, sem fluxo de pedido.
  const shouldInvokeBot = hadUserText || hadInteractiveText;

  return {
    displayText,
    mediaType,
    primaryKey,
    shouldInvokeBot,
    unknownKeys: keys,
    parseNote,
    rawSnippet,
  };
}

module.exports = {
  unwrapProtoMessage,
  parseBaileysMessageContent,
  humanMediaFallback,
};
