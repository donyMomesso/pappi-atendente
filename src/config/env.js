// src/config/env.js

require("dotenv").config();

function toNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// APP_ENV: prod | staging | dev | local — isolamento de sessão Baileys entre ambientes
function resolveAppEnv() {
  const v = (process.env.APP_ENV || "").trim().toLowerCase();
  if (["prod", "production", "staging", "homolog", "dev", "development", "local"].includes(v)) {
    if (v === "production") return "prod";
    if (v === "homolog") return "staging";
    if (v === "development") return "dev";
    return v;
  }
  return process.env.NODE_ENV === "production" ? "prod" : process.env.NODE_ENV === "development" ? "dev" : "local";
}

module.exports = {
  NODE_ENV: process.env.NODE_ENV || "development",
  APP_ENV: resolveAppEnv(),
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
  GEMINI_MODEL: (process.env.GEMINI_MODEL || "gemini-2.5-flash").replace(/^models\//, ""),
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
  OPENAI_MODEL: (process.env.OPENAI_MODEL || "gpt-4o-mini").trim(),
  GROQ_API_KEY: process.env.GROQ_API_KEY || "",
  GROQ_MODEL: (process.env.GROQ_MODEL || "llama-3.1-8b-instant").trim(),
  // Motor de IA: sequência de fallback. Ex: "gemini,groq,openai"
  AI_PROVIDER_SEQUENCE: (process.env.AI_PROVIDER_SEQUENCE || "gemini,groq,openai").trim(),
  // Transcrição de áudio: só gemini e openai suportam. Ex: "gemini,openai"
  AI_TRANSCRIBE_SEQUENCE: (process.env.AI_TRANSCRIBE_SEQUENCE || "gemini,openai").trim(),
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
  // ── Auth corporativa (Supabase) ──
  SUPABASE_URL: process.env.SUPABASE_URL || "",
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || "",
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  API_URL: (process.env.API_URL || process.env.APP_URL || "https://pappiatendente.com.br").replace(/\/$/, ""),
  CORS_ORIGIN: process.env.CORS_ORIGIN || process.env.APP_URL || "",
  // true = painel exige sessão Supabase; false = aceita API key como fallback
  USE_STAFF_AUTH: process.env.USE_STAFF_AUTH !== "false",
  // aceita API key quando sessão inválida (integrações). Se Supabase não configurado, fallback ativo.
  ALLOW_API_KEY_FALLBACK:
    process.env.ALLOW_API_KEY_FALLBACK === "true" ||
    (!process.env.SUPABASE_URL && process.env.ALLOW_API_KEY_FALLBACK !== "false"),
  // ── Produção privada ──
  BAILEYS_ENABLED: process.env.BAILEYS_ENABLED !== "false",
  BAILEYS_INSTANCE_MODE: process.env.BAILEYS_INSTANCE_MODE || "embedded",
  // true = ao receber 440, limpa auth — use com critério (ver docs/BAILEYS_440.md)
  BAILEYS_CLEAR_AUTH_ON_440: process.env.BAILEYS_CLEAR_AUTH_ON_440 === "true",
  BAILEYS_LOCK_TTL_MS: toNumber(process.env.BAILEYS_LOCK_TTL_MS, 60_000),
  BAILEYS_PROCESS_NAME: process.env.BAILEYS_PROCESS_NAME || "pappi-baileys",
  BAILEYS_HOSTNAME: process.env.BAILEYS_HOSTNAME || require("os").hostname(),
  WEB_CONCURRENCY: toNumber(process.env.WEB_CONCURRENCY, 1),
  RUN_JOBS: process.env.RUN_JOBS !== "false",
  RUN_BAILEYS: process.env.RUN_BAILEYS !== "false",
  LOG_LEVEL: process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug"),
  HEALTHCHECK_TOKEN: process.env.HEALTHCHECK_TOKEN || "",
  REDIS_URL: process.env.REDIS_URL || "",
  SENTRY_DSN: process.env.SENTRY_DSN || "",
};
