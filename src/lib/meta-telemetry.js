// src/lib/meta-telemetry.js
// Telemetria em memória para webhooks e erros Meta (Instagram/Facebook).
// Usado pelo webhook.routes e meta-social.service; lido pelo dashboard.

const state = {
  instagram: { lastWebhook: null, lastError: null },
  facebook: { lastWebhook: null, lastError: null },
  /** Último roteamento WhatsApp Cloud API (metadata.phone_number_id → tenant) */
  whatsappCloud: { lastRouting: null },
};

function recordInstagramWebhook({ at, senderId, recipientId }) {
  state.instagram.lastWebhook = { at, senderId, recipientId };
}

function recordFacebookWebhook({ at, senderId, recipientId }) {
  state.facebook.lastWebhook = { at, senderId, recipientId };
}

function recordInstagramError(message) {
  state.instagram.lastError = typeof message === "string" ? message : (message?.message || String(message));
}

function recordFacebookError(message) {
  state.facebook.lastError = typeof message === "string" ? message : (message?.message || String(message));
}

/**
 * @param {object} p
 * @param {string} [p.at] ISO
 * @param {string} p.phoneNumberId metadata.phone_number_id normalizado
 * @param {'matched'|'unmatched'|'inactive'} p.resolution
 * @param {string} [p.tenantId]
 * @param {string} [p.tenantName]
 */
function recordWhatsAppCloudRouting({ at, phoneNumberId, resolution, tenantId, tenantName }) {
  state.whatsappCloud.lastRouting = {
    at: at || new Date().toISOString(),
    phoneNumberId: phoneNumberId || null,
    resolution: resolution || "unmatched",
    tenantId: tenantId || null,
    tenantName: tenantName || null,
  };
}

function getWhatsAppCloudTelemetry() {
  const r = state.whatsappCloud.lastRouting;
  return {
    lastWebhookAt: r?.at || null,
    lastPhoneNumberIdReceived: r?.phoneNumberId || null,
    lastResolution: r?.resolution || null,
    lastMatchedTenantId: r?.tenantId || null,
    lastMatchedTenantName: r?.tenantName || null,
  };
}

function getMetaTelemetry() {
  return {
    instagram: {
      lastWebhookAt: state.instagram.lastWebhook?.at || null,
      lastSenderId: state.instagram.lastWebhook?.senderId || null,
      lastRecipientId: state.instagram.lastWebhook?.recipientId || null,
      lastError: state.instagram.lastError || null,
    },
    facebook: {
      lastWebhookAt: state.facebook.lastWebhook?.at || null,
      lastSenderId: state.facebook.lastWebhook?.senderId || null,
      lastRecipientId: state.facebook.lastWebhook?.recipientId || null,
      lastError: state.facebook.lastError || null,
    },
    whatsappCloud: getWhatsAppCloudTelemetry(),
  };
}

module.exports = {
  recordInstagramWebhook,
  recordFacebookWebhook,
  recordInstagramError,
  recordFacebookError,
  recordWhatsAppCloudRouting,
  getWhatsAppCloudTelemetry,
  getMetaTelemetry,
};
