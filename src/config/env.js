// src/config/env.js
// Variáveis globais (fallback para single-tenant / dev)
// Em multi-tenant, cada tenant tem seu próprio config no banco.

require("dotenv").config();

function toNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: toNumber(process.env.PORT, 10000),

  // ── Webhook ──────────────────────────────────────────────
  // Token de verificação do webhook Meta (pode ser por tenant no banco)
  WEBHOOK_VERIFY_TOKEN: process.env.WEBHOOK_VERIFY_TOKEN || "",

  // ── WhatsApp Cloud API (fallback single-tenant) ───────────
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN || "",
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
  WHATSAPP_WABA_ID: process.env.WHATSAPP_WABA_ID || "",

  // ── CardápioWeb (fallback single-tenant) ─────────────────
  CARDAPIOWEB_BASE_URL:
    process.env.CARDAPIOWEB_BASE_URL || "https://integracao.cardapioweb.com",
  CARDAPIOWEB_API_KEY:
    process.env.CARDAPIOWEB_API_KEY || process.env.CARDAPIOWEB_TOKEN || "",
  CARDAPIOWEB_PARTNER_KEY: process.env.CARDAPIOWEB_PARTNER_KEY || "",
  CARDAPIOWEB_STORE_ID: process.env.CARDAPIOWEB_STORE_ID || "",

  // ── Banco interno (Supabase / Neon / Railway) ─────────────
  DATABASE_URL: process.env.DATABASE_URL || "",
  DIRECT_URL: process.env.DIRECT_URL || process.env.DATABASE_URL || "",

  // ── Segurança interna ──────────────────────────────────────
  ATTENDANT_API_KEY: process.env.ATTENDANT_API_KEY || "",
  ADMIN_API_KEY: process.env.ADMIN_API_KEY || "",

  // ── Google OAuth ───────────────────────────────────────────
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || "",

  // ── Google Maps ────────────────────────────────────────────
  GOOGLE_MAPS_API_KEY:
    process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_KEY || "",

  // ── Gemini (IA) ────────────────────────────────────────────
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
  GEMINI_MODEL: (process.env.GEMINI_MODEL || "gemini-2.0-flash").replace(
    /^models\//,
    ""
  ),

  // ── Loja (coordenadas, fallback) ───────────────────────────
  STORE_LAT: toNumber(process.env.STORE_LAT, null),
  STORE_LNG: toNumber(process.env.STORE_LNG, null),

  // ── Banco Inter (PIX) ─────────────────────────────────────
  INTER_CERT_PATH: process.env.INTER_CERT_PATH || "",
  INTER_KEY_PATH: process.env.INTER_KEY_PATH || "",
  INTER_CA_PATH: process.env.INTER_CA_PATH || "",
  INTER_CLIENT_ID: process.env.INTER_CLIENT_ID || "",
  INTER_CLIENT_SECRET: process.env.INTER_CLIENT_SECRET || "",
  INTER_CHAVE_PIX: process.env.INTER_CHAVE_PIX || "",
  INTER_CONTA_CORRENTE: process.env.INTER_CONTA_CORRENTE || "",
};
