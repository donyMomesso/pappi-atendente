// src/services/openai-fallback.service.js
// Fallback para OpenAI (GPT-4o-mini) quando Gemini falha — redundância de IA

const ENV = require("../config/env");

const OPENAI_API = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";

function hasOpenAIKey() {
  const key = ENV.OPENAI_API_KEY || "";
  return !!key && key.length > 10;
}

/**
 * Gera texto via OpenAI Chat Completions (REST).
 * @param {string} prompt - Prompt do usuário
 * @param {{ temperature?: number, maxTokens?: number }} opts
 * @returns {Promise<string>} Texto gerado
 */
async function generate(prompt, opts = {}) {
  const key = ENV.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY não configurado");

  const model = (ENV.OPENAI_MODEL || DEFAULT_MODEL).trim();
  const temperature = opts.temperature ?? 0.7;
  const maxTokens = opts.maxTokens ?? 1024;

  const res = await fetch(OPENAI_API, {
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
    throw new Error(`OpenAI ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenAI retornou resposta vazia");
  return text;
}

module.exports = { generate, hasOpenAIKey };
