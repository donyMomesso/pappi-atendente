// src/services/audio-transcribe.service.js
// Transcreve áudios via Motor de IA (sequência gemini→openai).
// Muito comum no Brasil: clientes preferem mandar áudio a digitar.
//
// Fluxo:
//   1. Recebe URL do áudio (via wa.getMediaUrl)
//   2. Baixa o arquivo em memória como buffer
//   3. Envia para o Motor de IA (Gemini multimodal ou OpenAI Whisper)
//   4. Retorna texto transcrito ou null se falhar

const aiMotor = require("./ai-motor.service");
const ENV = require("../config/env");

const SUPPORTED_TYPES = ["audio/ogg", "audio/mpeg", "audio/mp4", "audio/webm", "audio/opus"];
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const DOWNLOAD_TIMEOUT_MS = 30000;

async function fetchAudioWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Baixa o áudio da URL do WhatsApp e transcreve via Motor de IA.
 *
 * @param {string} mediaUrl  URL retornada por wa.getMediaUrl()
 * @param {string} token     Bearer token do WABA (para autenticar o download)
 * @returns {Promise<string|null>}  Texto transcrito ou null
 */
async function transcribeAudio(mediaUrl, token) {
  if (!mediaUrl) return null;

  const hasTranscribe = !!ENV.GEMINI_API_KEY || !!ENV.OPENAI_API_KEY;
  if (!hasTranscribe) return null;

  try {
    const audioResp = await fetchAudioWithTimeout(mediaUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!audioResp.ok) {
      console.warn("[AudioTranscribe] Falha ao baixar áudio:", audioResp.status);
      return null;
    }

    const contentType = audioResp.headers.get("content-type") || "audio/ogg";
    const contentLength = parseInt(audioResp.headers.get("content-length") || "0", 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_SIZE_BYTES) {
      console.warn("[AudioTranscribe] Áudio muito grande no download:", contentLength, "bytes");
      return null;
    }
    const arrayBuf = await audioResp.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    return transcribeAudioBuffer(buffer, contentType);
  } catch (err) {
    console.warn("[AudioTranscribe] Erro:", err.message);
    return null;
  }
}

async function transcribeAudioBuffer(buffer, contentType = "audio/ogg") {
  if (!buffer || !Buffer.isBuffer(buffer) || !buffer.byteLength) return null;
  const hasTranscribe = !!ENV.GEMINI_API_KEY || !!ENV.OPENAI_API_KEY;
  if (!hasTranscribe) return null;

  if (buffer.byteLength > MAX_SIZE_BYTES) {
    console.warn("[AudioTranscribe] Áudio muito grande:", buffer.byteLength, "bytes");
    return null;
  }

  try {
    const mimeType = SUPPORTED_TYPES.includes(contentType) ? contentType : "audio/ogg";
    const { text } = await aiMotor.transcribe(buffer, mimeType);
    if (!text) return null;
    console.log(`[AudioTranscribe] Transcrito (${buffer.byteLength}b): "${text.slice(0, 80)}..."`);
    return text;
  } catch (err) {
    console.warn("[AudioTranscribe] Erro ao transcrever buffer:", err.message);
    return null;
  }
}

module.exports = { transcribeAudio, transcribeAudioBuffer };
