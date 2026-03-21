// src/services/google-contacts.service.js
// CORREÇÃO: usa singleton do PrismaClient

const prisma = require("../lib/db");
const TOKEN_KEY = "google_contacts_tokens";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CONTACTS_URL = "https://people.googleapis.com/v1/people:createContact";
function getRedirectUri() {
  const ENV = require("../config/env");
  return `${ENV.APP_URL}/dash/google-contacts/callback`;
}
const SCOPE = "https://www.googleapis.com/auth/contacts";

function cfg() {
  const ENV = require("../config/env");
  return { clientId: ENV.GOOGLE_CLIENT_ID, clientSecret: ENV.GOOGLE_CLIENT_SECRET };
}

function getAuthUrl() {
  const { clientId } = cfg();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getRedirectUri(),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeCode(code) {
  const { clientId, clientSecret } = cfg();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: getRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error("Erro ao trocar código: " + (await res.text()));
  return res.json();
}

async function saveTokens(tokens, existingRefresh = null) {
  const value = JSON.stringify({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || existingRefresh,
    expiry: Date.now() + (tokens.expires_in || 3600) * 1000,
  });
  await prisma.config.upsert({
    where: { key: TOKEN_KEY },
    create: { key: TOKEN_KEY, value },
    update: { value },
  });
}

async function getAccessToken() {
  const row = await prisma.config.findUnique({ where: { key: TOKEN_KEY } }).catch(() => null);
  if (!row) return null;
  const tokens = JSON.parse(row.value);
  if (!tokens.refresh_token) return null;
  if (Date.now() < tokens.expiry - 60_000) return tokens.access_token;

  const { clientId, clientSecret } = cfg();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) return null;
  const refreshed = await res.json();
  await saveTokens(refreshed, tokens.refresh_token);
  return refreshed.access_token;
}

async function isAuthorized() {
  const row = await prisma.config.findUnique({ where: { key: TOKEN_KEY } }).catch(() => null);
  if (!row) return false;
  const t = JSON.parse(row.value);
  return !!t.refresh_token;
}

async function createContact(name, phone) {
  try {
    const token = await getAccessToken();
    if (!token) return false;
    const body = {
      names: name ? [{ displayName: name, givenName: name }] : [],
      phoneNumbers: [{ value: `+${phone}`, type: "mobile" }],
    };
    const res = await fetch(`${CONTACTS_URL}?personFields=names,phoneNumbers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      console.log(`[GoogleContacts] Contato criado: ${name || phone}`);
      return true;
    }
    return false;
  } catch (e) {
    console.error("[GoogleContacts] Exceção:", e.message);
    return false;
  }
}

async function searchContacts(query) {
  try {
    const token = await getAccessToken();
    if (!token) return [];
    const params = new URLSearchParams({ query, readMask: "names,phoneNumbers", pageSize: 20 });
    const res = await fetch(`https://people.googleapis.com/v1/people:searchContacts?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || [])
      .map((r) => {
        const p = r.person;
        const name = p.names?.[0]?.displayName || "";
        const phone = p.phoneNumbers?.[0]?.value?.replace(/\D/g, "") || "";
        return { name, phone };
      })
      .filter((c) => c.phone);
  } catch (e) {
    return [];
  }
}

async function disconnect() {
  await prisma.config.deleteMany({ where: { key: TOKEN_KEY } }).catch(() => {});
}

module.exports = { getAuthUrl, exchangeCode, saveTokens, isAuthorized, createContact, searchContacts, disconnect };
