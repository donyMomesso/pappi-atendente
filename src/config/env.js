// src/config/env.js

require("dotenv").config();

function toNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: toNumber(process.env.PORT, 10000),
  APP_URL: (process.env.APP_URL || "https://pappiatendente.com.br").replace(/\/$/, ""),
  WEBHOOK_VERIFY_TOKEN: process.env.WEBHOOK_VERIFY_TOKEN || "",
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN || "",
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
  WHATSAPP_WABA_ID: process.env.WHATSAPP_WABA_ID || "",
  CARDAPIOWEB_BASE_URL: process.env.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com",
  CARDAPIOWEB_API_KEY: process.env.CARDAPIOWEB_API_KEY || process.env.CARDAPIOWEB_TOKEN || "",
  CARDAPIOWEB_PARTNER_KEY: process.env.CARDAPIOWEB_PARTNER_KEY || "",
  CARDAPIOWEB_STORE_ID: process.env.CARDAPIOWEB_STORE_ID || "",
  DATABASE_URL: process.env.DATABASE_URL || "",
  DIRECT_URL: process.env.DIRECT_URL || process.env.DATABASE_URL || "",
  ATTENDANT_API_KEY: process.env.ATTENDANT_API_KEY || "",
  ADMIN_API_KEY: process.env.ADMIN_API_KEY || "",
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || "",
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || "",
  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_KEY || "",
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
  GEMINI_MODEL: (process.env.GEMINI_MODEL || "gemini-2.0-flash").replace(/^models\//, ""),
  INSTAGRAM_PAGE_ID: process.env.INSTAGRAM_PAGE_ID || "",
  FACEBOOK_PAGE_ID: process.env.FACEBOOK_PAGE_ID || "",
  FACEBOOK_PAGE_TOKEN: process.env.FACEBOOK_PAGE_TOKEN || "",
  STORE_LAT: toNumber(process.env.STORE_LAT, null),
  STORE_LNG: toNumber(process.env.STORE_LNG, null),
  INTER_CERT_PATH: process.env.INTER_CERT_PATH || "",
  INTER_KEY_PATH: process.env.INTER_KEY_PATH || "",
  INTER_CA_PATH: process.env.INTER_CA_PATH || "",
  INTER_CLIENT_ID: process.env.INTER_CLIENT_ID || "",
  INTER_CLIENT_SECRET: process.env.INTER_CLIENT_SECRET || "",
  INTER_CHAVE_PIX: process.env.INTER_CHAVE_PIX || "",
  INTER_CONTA_CORRENTE: process.env.INTER_CONTA_CORRENTE || "",
  // HORÁRIO: SKIP_HOURS_CHECK=true desativa a trava para testes
  SKIP_HOURS_CHECK: process.env.SKIP_HOURS_CHECK === "true",
  // HORÁRIO: CLOSED_AS_LEAD=true permite receber pedidos quando fechado (salva como lead para contato)
  CLOSED_AS_LEAD: process.env.CLOSED_AS_LEAD === "true",
  // Híbrido: minutos de inatividade para devolver ao robô (0 = desativado)
  CONVERSATION_HANDOFF_TIMEOUT_MIN: toNumber(process.env.CONVERSATION_HANDOFF_TIMEOUT_MIN, 0),
};
