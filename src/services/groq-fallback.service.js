// src/services/groq-fallback.service.js
// Fallback para Groq (Llama) — API OpenAI-compatível, muito rápida

const ENV = require("../config/env");

const GROQ_API = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "llama-3.1-8b-instant";

function hasGroqKey() {
  const key = ENV.GROQ_API_KEY || "";
  return !!key && key.length > 10;
}

/**
 * Gera texto via Groq Chat Completions (API OpenAI-compatível).
 * @param {string} prompt - Prompt do usuário
 * @param {{ temperature?: number, maxTokens?: number }} opts
 * @returns {Promise<string>} Texto gerado
 */
async function generate(prompt, opts = {}) {
  const key = ENV.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY não configurado");

  const model = (ENV.GROQ_MODEL || DEFAULT_MODEL).trim();
  const temperature = opts.temperature ?? 0.7;
  const maxTokens = opts.maxTokens ?? 1024;

  const res = await fetch(GROQ_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: String(prompt) }],
      temperature,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Groq ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Groq retornou resposta vazia");
  return text;
}

module.exports = { generate, hasGroqKey };
