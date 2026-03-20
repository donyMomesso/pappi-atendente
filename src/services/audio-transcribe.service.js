// src/services/audio-transcribe.service.js
// Transcreve áudios recebidos via WhatsApp usando a API multimodal do Gemini.
// Muito comum no Brasil: clientes preferem mandar áudio a digitar.
//
// Fluxo:
//   1. Recebe URL do áudio (via wa.getMediaUrl)
//   2. Baixa o arquivo em memória como buffer
//   3. Envia para Gemini como base64 com instrução de transcrição
//   4. Retorna texto transcrito ou null se falhar

const ENV = require("../config/env");

const SUPPORTED_TYPES = ["audio/ogg", "audio/mpeg", "audio/mp4", "audio/webm", "audio/opus"];
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Baixa o áudio da URL do WhatsApp e transcreve com Gemini.
 *
 * @param {string} mediaUrl  URL retornada por wa.getMediaUrl()
 * @param {string} token     Bearer token do WABA (para autenticar o download)
 * @returns {Promise<string|null>}  Texto transcrito ou null
 */
async function transcribeAudio(mediaUrl, token) {
  if (!ENV.GEMINI_API_KEY) return null;
  if (!mediaUrl) return null;

  try {
    // 1. Baixa o áudio com autenticação Meta
    const audioResp = await fetch(mediaUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!audioResp.ok) {
      console.warn("[AudioTranscribe] Falha ao baixar áudio:", audioResp.status);
      return null;
    }

    const contentType = audioResp.headers.get("content-type") || "audio/ogg";
    const buffer = await audioResp.arrayBuffer();

    if (buffer.byteLength > MAX_SIZE_BYTES) {
      console.warn("[AudioTranscribe] Áudio muito grande:", buffer.byteLength, "bytes");
      return null;
    }

    const base64Data = Buffer.from(buffer).toString("base64");

    // 2. Envia para Gemini multimodal
    const { GoogleGenerativeAI } = require("@google/generative-ai");
    const client = new GoogleGenerativeAI(ENV.GEMINI_API_KEY);
    const model = client.getGenerativeModel({
      model: ENV.GEMINI_MODEL || "gemini-2.0-flash",
      generationConfig: { temperature: 0, maxOutputTokens: 512 },
    });

    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: SUPPORTED_TYPES.includes(contentType) ? contentType : "audio/ogg",
          data: base64Data,
        },
      },
      {
        text:
          "Transcreva exatamente o que está sendo dito neste áudio em português brasileiro. " +
          "Retorne apenas o texto transcrito, sem introdução, sem aspas, sem explicações.",
      },
    ]);

    const transcription = result.response.text().trim();
    if (!transcription) return null;

    console.log(`[AudioTranscribe] Transcrito (${buffer.byteLength}b): "${transcription.slice(0, 80)}..."`);
    return transcription;
  } catch (err) {
    console.warn("[AudioTranscribe] Erro:", err.message);
    return null;
  }
}

module.exports = { transcribeAudio };
