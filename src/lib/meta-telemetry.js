// src/lib/meta-telemetry.js
// Telemetria em memória para webhooks e erros Meta (Instagram/Facebook).
// Usado pelo webhook.routes e meta-social.service; lido pelo dashboard.

const state = {
  instagram: { lastWebhook: null, lastError: null },
  facebook: { lastWebhook: null, lastError: null },
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
  };
}

module.exports = {
  recordInstagramWebhook,
  recordFacebookWebhook,
  recordInstagramError,
  recordFacebookError,
  getMetaTelemetry,
};
