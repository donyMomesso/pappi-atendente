// src/services/inter-pix.service.js
// Integração mínima com Inter Pix Cob (cobrança imediata) — usada para PIX pendente antes de enviar ao Cardápio Web.
// Requer mTLS (cert/key/ca) e OAuth2 client_credentials.

const fs = require("fs");
const https = require("https");
const fetch = require("node-fetch");
const ENV = require("../config/env");

function getBase() {
  // Permite sandbox via env sem refatoração
  const sandbox = String(process.env.INTER_SANDBOX || "").toLowerCase() === "true";
  return sandbox ? "https://cdpj-sandbox.partners.uatinter.co" : "https://cdpj.partners.bancointer.com.br";
}

function buildAgent() {
  const certPath = ENV.INTER_CERT_PATH;
  const keyPath = ENV.INTER_KEY_PATH;
  const caPath = ENV.INTER_CA_PATH;
  if (!certPath || !keyPath) throw new Error("INTER_CERT_PATH/INTER_KEY_PATH não configurados");
  const cert = fs.readFileSync(certPath);
  const key = fs.readFileSync(keyPath);
  const ca = caPath ? fs.readFileSync(caPath) : undefined;
  return new https.Agent({ cert, key, ca, keepAlive: true });
}

async function getAccessToken() {
  const base = getBase();
  const clientId = ENV.INTER_CLIENT_ID;
  const clientSecret = ENV.INTER_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("INTER_CLIENT_ID/INTER_CLIENT_SECRET não configurados");

  const agent = buildAgent();
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: (process.env.INTER_SCOPE || "pix.write pix.read cob.write cob.read").trim(),
  }).toString();

  const resp = await fetch(`${base}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    agent,
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = data?.error_description || data?.error || JSON.stringify(data);
    throw new Error(`Inter OAuth falhou (${resp.status}): ${msg}`);
  }
  const token = data?.access_token;
  if (!token) throw new Error("Inter OAuth: access_token ausente");
  return token;
}

/**
 * Cria cobrança imediata PIX (Cob) no Inter usando txid idempotente.
 * Retorna dados úteis pro usuário (copia e cola) e para webhook.
 */
async function createCob({ txid, amount, payerName, message } = {}) {
  const base = getBase();
  const chave = (ENV.INTER_CHAVE_PIX || "").trim();
  if (!chave) throw new Error("INTER_CHAVE_PIX não configurado");
  if (!txid) throw new Error("txid obrigatório");
  const original = Number(amount);
  if (!Number.isFinite(original) || original <= 0) throw new Error("amount inválido");

  const token = await getAccessToken();
  const agent = buildAgent();

  const payload = {
    calendario: { expiracao: 3600 }, // 1h
    devedor: payerName ? { nome: String(payerName).slice(0, 200) } : undefined,
    valor: { original: original.toFixed(2) },
    chave,
    solicitacaoPagador: message ? String(message).slice(0, 140) : "Pagamento do pedido Pappi",
  };

  const resp = await fetch(`${base}/pix/v2/cob/${encodeURIComponent(txid)}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
    agent,
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = data?.detail || data?.message || JSON.stringify(data);
    throw new Error(`Inter Pix Cob falhou (${resp.status}): ${msg}`);
  }

  // Alguns retornos incluem "pixCopiaECola"; em outros é preciso buscar por loc.
  const copiaECola = data?.pixCopiaECola || data?.pixCopiaecola || data?.pixCopia || null;
  return {
    txid,
    raw: data,
    copiaECola,
  };
}

module.exports = { createCob };

