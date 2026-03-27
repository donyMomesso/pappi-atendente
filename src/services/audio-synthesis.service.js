const ENV = require("../config/env");

async function synthesizeTextToAudio(text) {
  if (!text || !String(text).trim()) return null;
  if (!ENV.OPENAI_API_KEY) {
    console.warn("[AudioSynthesis] OPENAI_API_KEY ausente");
    return null;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ENV.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        voice: "echo",
        input: String(text),
        response_format: "opus",
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.warn("[AudioSynthesis] Falha no TTS:", response.status, errText.slice(0, 200));
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    console.warn("[AudioSynthesis] Erro ao sintetizar áudio:", err?.message || err);
    return null;
  }
}

module.exports = { synthesizeTextToAudio };
