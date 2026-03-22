// src/services/weather.service.js
// Verificação de clima para fator de atraso (chuva).
// Usa Open-Meteo (gratuito, sem API key).

const log = require("../lib/logger").child({ service: "weather" });

const BASE = "https://api.open-meteo.com/v1";

/** @returns {{ rain: boolean, heavyRain: boolean, delayFactor: number }|null} */
async function getWeatherForCity(city) {
  if (!city || typeof city !== "string") return null;
  const trimmed = city.trim();
  if (!trimmed) return null;

  try {
    let lat = -23.55;
    let lng = -46.63;
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(trimmed)}&count=1&language=pt`;
    const geoResp = await fetch(geoUrl);
    const geoData = await geoResp.json();
    if (geoData?.results?.[0]) {
      lat = geoData.results[0].latitude;
      lng = geoData.results[0].longitude;
    }

    const url = `${BASE}/forecast?latitude=${lat}&longitude=${lng}&current=precipitation,weather_code&timezone=America/Sao_Paulo`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    const current = data?.current;
    if (!current) return null;

    const precip = Number(current.precipitation) || 0;
    const code = Number(current.weather_code) || 0;
    // WMO codes: 61-67 = rain, 80-82 = showers, 95-99 = thunderstorm
    const isRain = precip > 0 || [61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(code);
    const heavyRain = precip >= 2 || [65, 67, 82, 96, 99].includes(code);

    let delayFactor = 1;
    if (heavyRain) delayFactor = 1.25;
    else if (isRain) delayFactor = 1.15;

    return { rain: isRain, heavyRain, delayFactor };
  } catch (err) {
    log.warn({ err: err.message, city }, "Falha ao obter clima");
    return null;
  }
}

module.exports = { getWeatherForCity };
