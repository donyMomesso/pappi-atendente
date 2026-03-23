// src/services/ai-motor.service.js
// Motor de IA: sequência de 3 providers (1→2→3). Se um falhar, tenta o próximo.
// Ordem configurável via AI_PROVIDER_SEQUENCE (ex: "gemini,groq,openai")
// Futuro: cada tenant poderá configurar sua própria sequência (tenantId em opts).

const ENV = require("../config/env");
const openaiFallback = require("./openai-fallback.service");
const groqFallback = require("./groq-fallback.service");

const DEFAULT_SEQUENCE = ["gemini", "groq", "openai"];
const DEFAULT_TRANSCRIBE_SEQUENCE = ["gemini", "openai"];
const SUPPORTED_AUDIO_TYPES = ["audio/ogg", "audio/mpeg", "audio/mp4", "audio/webm", "audio/opus"];

/**
 * Retorna a sequência de providers configurada.
 * Env: AI_PROVIDER_SEQUENCE=gemini,groq,openai
 */
function getSequence() {
  const raw = (ENV.AI_PROVIDER_SEQUENCE || "").trim().toLowerCase();
  if (!raw) return DEFAULT_SEQUENCE;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_SEQUENCE;
}

/**
 * Retorna a sequência para transcrição de áudio (só gemini e openai suportam).
 * Env: AI_TRANSCRIBE_SEQUENCE=gemini,openai
 */
function getTranscribeSequence() {
  const raw = (ENV.AI_TRANSCRIBE_SEQUENCE || "").trim().toLowerCase();
  if (!raw) return DEFAULT_TRANSCRIBE_SEQUENCE;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_TRANSCRIBE_SEQUENCE;
}

/**
 * Provider Gemini (Google).
 */
async function generateGemini(prompt, opts) {
  const { GoogleGenerativeAI } = require("@google/generative-ai");
  const client = new GoogleGenerativeAI(ENV.GEMINI_API_KEY);
  const model = client.getGenerativeModel({
    model: ENV.GEMINI_MODEL || "gemini-2.5-flash",
    generationConfig: {
      temperature: opts.temperature ?? 0.7,
      maxOutputTokens: opts.maxTokens ?? 1024,
    },
  });
  const result = await model.generateContent(prompt);
  const text = result?.response?.text?.();
  if (!text || typeof text !== "string") throw new Error("Gemini retornou resposta vazia");
  return text.trim();
}

/**
 * Provider Groq (Llama).
 */
async function generateGroq(prompt, opts) {
  return groqFallback.generate(prompt, {
    temperature: opts.temperature ?? 0.7,
    maxTokens: opts.maxTokens ?? 1024,
  });
}

/**
 * Provider OpenAI (GPT).
 */
async function generateOpenAI(prompt, opts) {
  return openaiFallback.generate(prompt, {
    temperature: opts.temperature ?? 0.7,
    maxTokens: opts.maxTokens ?? 1024,
  });
}

const PROVIDERS = {
  gemini: {
    generate: generateGemini,
    hasKey: () => !!(ENV.GEMINI_API_KEY && ENV.GEMINI_API_KEY.length > 10),
  },
  groq: {
    generate: generateGroq,
    hasKey: () => groqFallback.hasGroqKey(),
  },
  openai: {
    generate: generateOpenAI,
    hasKey: () => openaiFallback.hasOpenAIKey(),
  },
};

/**
 * Gera texto usando a sequência de providers.
 * Tenta o 1º; se falhar, tenta o 2º; se falhar, tenta o 3º.
 *
 * @param {string} prompt
 * @param {{ temperature?: number, maxTokens?: number }} opts
 * @returns {Promise<{ text: string, provider: string }>}
 */
async function generate(prompt, opts = {}) {
  const sequence = getSequence();
  let lastErr = null;

  for (const providerId of sequence) {
    const provider = PROVIDERS[providerId];
    if (!provider) {
      console.warn(`[AI-Motor] Provider desconhecido: ${providerId}`);
      continue;
    }
    if (!provider.hasKey()) continue;

    try {
      if (providerId === "gemini") {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const text = await provider.generate(prompt, opts);
            return { text, provider: providerId };
          } catch (err) {
            const is429 = err?.message?.includes("429") || err?.code === 429;
            if (is429 && attempt < 2) {
              await new Promise((r) => setTimeout(r, 2000 * attempt));
              continue;
            }
            throw err;
          }
        }
      }

      const text = await provider.generate(prompt, opts);
      return { text, provider: providerId };
    } catch (err) {
      lastErr = err;
      console.warn(`[AI-Motor] ${providerId} falhou:`, err.message);
    }
  }

  throw lastErr || new Error("Nenhum provider de IA configurado ou disponível");
}

/**
 * Transcrição via Gemini (multimodal).
 */
async function transcribeGemini(buffer, mimeType) {
  const { GoogleGenerativeAI } = require("@google/generative-ai");
  const client = new GoogleGenerativeAI(ENV.GEMINI_API_KEY);
  const model = client.getGenerativeModel({
    model: ENV.GEMINI_MODEL || "gemini-2.5-flash",
    generationConfig: { temperature: 0, maxOutputTokens: 512 },
  });
  const base64 = Buffer.isBuffer(buffer) ? buffer.toString("base64") : buffer;
  const result = await model.generateContent([
    { inlineData: { mimeType: SUPPORTED_AUDIO_TYPES.includes(mimeType) ? mimeType : "audio/ogg", data: base64 } },
    { text: "Transcreva exatamente o que está sendo dito neste áudio em português brasileiro. Retorne apenas o texto transcrito, sem introdução, sem aspas, sem explicações." },
  ]);
  const text = result?.response?.text?.()?.trim();
  if (!text) throw new Error("Gemini retornou transcrição vazia");
  return text;
}

/**
 * Transcrição via OpenAI Whisper.
 */
async function transcribeOpenAI(buffer, mimeType) {
  const key = ENV.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY não configurado");
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const ext = (mimeType || "").includes("mpeg") ? "mp3" : (mimeType || "").includes("mp4") ? "m4a" : "ogg";
  const FormData = require("form-data");
  const form = new FormData();
  form.append("file", buf, { filename: `audio.${ext}` });
  form.append("model", "whisper-1");
  form.append("language", "pt");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, ...form.getHeaders() },
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`OpenAI Whisper ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data?.text?.trim();
  if (!text) throw new Error("OpenAI Whisper retornou transcrição vazia");
  return text;
}

const TRANSCRIBE_PROVIDERS = {
  gemini: { transcribe: transcribeGemini, hasKey: () => !!(ENV.GEMINI_API_KEY && ENV.GEMINI_API_KEY.length > 10) },
  openai: { transcribe: transcribeOpenAI, hasKey: () => openaiFallback.hasOpenAIKey() },
};

/**
 * Transcreve áudio usando a sequência de providers (gemini→openai).
 * @param {Buffer|ArrayBuffer} buffer - Áudio em bytes
 * @param {string} mimeType - Ex: audio/ogg, audio/mpeg
 * @returns {Promise<{ text: string, provider: string }>}
 */
async function transcribe(buffer, mimeType = "audio/ogg") {
  const sequence = getTranscribeSequence();
  let lastErr = null;
  for (const providerId of sequence) {
    const provider = TRANSCRIBE_PROVIDERS[providerId];
    if (!provider?.hasKey()) continue;
    try {
      const text = await provider.transcribe(buffer, mimeType);
      return { text, provider: providerId };
    } catch (err) {
      lastErr = err;
      console.warn(`[AI-Motor] transcribe ${providerId} falhou:`, err.message);
    }
  }
  throw lastErr || new Error("Nenhum provider de transcrição configurado (gemini ou openai)");
}

/**
 * Testa conectividade de cada provider configurado.
 * @returns {Promise<Object>}
 */
async function testProviders() {
  const result = { sequence: getSequence(), providers: {} };

  for (const id of ["gemini", "groq", "openai"]) {
    const p = PROVIDERS[id];
    if (!p.hasKey()) {
      result.providers[id] = "not_configured";
      continue;
    }

    try {
      const text =
        id === "gemini"
          ? await generateGemini("Responda apenas: OK", { temperature: 0, maxTokens: 10 })
          : id === "groq"
            ? await groqFallback.generate("Responda apenas: OK", { temperature: 0, maxTokens: 10 })
            : await openaiFallback.generate("Responda apenas: OK", { temperature: 0, maxTokens: 10 });
      result.providers[id] = text?.trim() === "OK" ? "ok" : "unexpected";
    } catch (err) {
      result.providers[id] = "fail";
      result[`${id}Error`] = err.message?.slice(0, 100);
    }
  }

  return result;
}

module.exports = {
  generate,
  transcribe,
  getSequence,
  getTranscribeSequence,
  testProviders,
  PROVIDERS,
};
