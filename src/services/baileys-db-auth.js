// src/services/baileys-db-auth.js
// Armazena as credenciais do Baileys no banco (Supabase/Postgres)
// Suporta múltiplas instâncias (Multi-WhatsApp)

const prisma = require("../lib/db");
const { initAuthCreds, BufferJSON } = require("@whiskeysockets/baileys");

async function useDbAuthState(instanceId = "default") {
  const DB_KEY = `baileys:auth:${instanceId}`;

  async function readState() {
    const row = await prisma.config.findUnique({ where: { key: DB_KEY } }).catch(() => null);
    if (!row?.value) return {};
    try { return JSON.parse(row.value, BufferJSON.reviver); }
    catch { return {}; }
  }

  async function writeState(data) {
    const value = JSON.stringify(data, BufferJSON.replacer);
    await prisma.config.upsert({
      where:  { key: DB_KEY },
      create: { key: DB_KEY, value },
      update: { value },
    }).catch(e => console.error(`[BaileysDB:${instanceId}] Erro ao salvar auth:`, e.message));
  }

  const stored = await readState();
  const creds  = stored.creds || initAuthCreds();
  const keys   = stored.keys  || {};

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const data = {};
        for (const id of ids) {
          const val = keys[`${type}-${id}`];
          if (val !== undefined) data[id] = val;
        }
        return data;
      },
      set: async (data) => {
        for (const [category, entries] of Object.entries(data)) {
          for (const [id, value] of Object.entries(entries || {})) {
            if (value) keys[`${category}-${id}`] = value;
            else delete keys[`${category}-${id}`];
          }
        }
        await writeState({ creds, keys });
      },
    },
  };

  const saveCreds = async () => {
    await writeState({ creds, keys });
  };

  return { state, saveCreds };
}

async function clearDbAuth(instanceId = "default") {
  const DB_KEY = `baileys:auth:${instanceId}`;
  await prisma.config.deleteMany({ where: { key: DB_KEY } }).catch(() => {});
}

async function listInstances() {
  const configs = await prisma.config.findMany({
    where: { key: { startsWith: "baileys:auth:" } },
  });
  return configs.map(c => c.key.replace("baileys:auth:", ""));
}

module.exports = { useDbAuthState, clearDbAuth, listInstances };
