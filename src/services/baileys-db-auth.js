// src/services/baileys-db-auth.js
// Armazena as credenciais do Baileys no banco (Supabase/Postgres)
// em vez do filesystem — resolve o problema do Render apagar arquivos

const { PrismaClient } = require("@prisma/client");
const { initAuthCreds, BufferJSON } = require("@whiskeysockets/baileys");

const prisma = new PrismaClient();
const DB_KEY = "baileys:auth";

async function useDbAuthState() {
  // Carrega estado salvo do banco
  async function readState() {
    const row = await prisma.config.findUnique({ where: { key: DB_KEY } }).catch(() => null);
    if (!row?.value) return {};
    try { return JSON.parse(row.value, BufferJSON.reviver); }
    catch { return {}; }
  }

  // Salva estado no banco
  async function writeState(data) {
    const value = JSON.stringify(data, BufferJSON.replacer);
    await prisma.config.upsert({
      where:  { key: DB_KEY },
      create: { key: DB_KEY, value },
      update: { value },
    }).catch(e => console.error("[BaileysDB] Erro ao salvar auth:", e.message));
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

async function clearDbAuth() {
  await prisma.config.deleteMany({ where: { key: DB_KEY } }).catch(() => {});
}

module.exports = { useDbAuthState, clearDbAuth };
