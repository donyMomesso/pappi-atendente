// src/services/maps.service.js

const ENV = require("../config/env");
const MAPS_BASE = "https://maps.googleapis.com/maps/api";

async function geocode(address) {
  if (!ENV.GOOGLE_MAPS_API_KEY) return null;
  try {
    const q = encodeURIComponent(address + ", Brasil");
    const resp = await fetch(`${MAPS_BASE}/geocode/json?address=${q}&region=br&key=${ENV.GOOGLE_MAPS_API_KEY}`);
    const data = await resp.json();
    if (data.status !== "OK" || !data.results?.[0]) return null;
    const r = data.results[0];
    return { lat: r.geometry.location.lat, lng: r.geometry.location.lng, formatted_address: r.formatted_address };
  } catch {
    return null;
  }
}

function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function quote(address, cw, store = {}) {
  const geo = await geocode(address);
  if (!geo) return null;

  const storeLat = store.lat ?? ENV.STORE_LAT;
  const storeLng = store.lng ?? ENV.STORE_LNG;

  let km = null,
    eta = null;
  if (storeLat && storeLng) {
    km = parseFloat(distanceKm(storeLat, storeLng, geo.lat, geo.lng).toFixed(1));
    eta = Math.round(km * 4 + 10);
  }

  let fee = null;
  if (cw) {
    try {
      fee = await cw.getDeliveryFee({ lat: geo.lat, lng: geo.lng });
    } catch {}
  }

  return {
    lat: geo.lat,
    lng: geo.lng,
    formatted_address: geo.formatted_address,
    km,
    eta_minutes: eta,
    delivery_fee: fee,
    is_serviceable: fee !== null,
  };
}

module.exports = { geocode, quote, distanceKm };
