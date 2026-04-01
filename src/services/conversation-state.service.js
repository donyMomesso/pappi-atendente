// src/services/conversation-state.service.js
// Estado da conversa para fluxo híbrido humano + robô.
// Usa Config table (sem migration) — key: conv:{customerId}

const prisma = require("../lib/db");
const logger = require("../lib/logger").child({ service: "conv-state" });

const CONFIG_PREFIX = "conv:";
const STATES = {
  BOT_ATIVO: "bot_ativo",
  AGUARDANDO_HUMANO: "aguardando_humano",
  HUMANO_ATIVO: "humano_ativo",
  ENCERRADO: "encerrado",
};

function configKey(customerId) {
  return `${CONFIG_PREFIX}${customerId}`;
}

/**
 * Retorna o estado atual. Se não houver Config, deriva de handoff/claimedBy.
 */
function stateFromCustomerRow(customer) {
  if (customer.handoff) {
    return customer.claimedBy ? STATES.HUMANO_ATIVO : STATES.AGUARDANDO_HUMANO;
  }
  return STATES.BOT_ATIVO;
}

async function getState(customer) {
  const key = configKey(customer.id);
  try {
    const cfg = await prisma.config.findUnique({ where: { key } });
    if (cfg?.value) {
      const parsed = JSON.parse(cfg.value);
      if (parsed.state && Object.values(STATES).includes(parsed.state)) {
        return parsed.state;
      }
    }
  } catch (err) {
    logger.error({ err, customerId: customer?.id, key }, "Falha ao ler estado da conversa (prisma.config)");
  }

  return stateFromCustomerRow(customer);
}

/**
 * Uma query para N clientes (painel /dash/conversations e /queue) — evita N× findUnique.
 * @param {Array<{ id: string, handoff?: boolean, claimedBy?: string | null }>} customers
 * @returns {Promise<Map<string, string>>} customerId → state
 */
async function getStatesForCustomers(customers) {
  const map = new Map();
  if (!Array.isArray(customers) || !customers.length) return map;

  const ids = customers.map((c) => c?.id).filter(Boolean);
  const keys = [...new Set(ids.map((id) => configKey(id)))];
  let rows = [];
  if (keys.length) {
    try {
      rows = await prisma.config.findMany({
        where: { key: { in: keys } },
        select: { key: true, value: true },
      });
    } catch (err) {
      logger.error({ err }, "Falha em getStatesForCustomers (batch config)");
    }
  }

  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  for (const c of customers) {
    if (!c?.id) continue;
    const key = configKey(c.id);
    let state = null;
    const raw = byKey.get(key);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.state && Object.values(STATES).includes(parsed.state)) {
          state = parsed.state;
        }
      } catch {}
    }
    map.set(c.id, state || stateFromCustomerRow(c));
  }
  return map;
}

/**
 * Persiste o estado.
 */
async function setState(customerId, state) {
  const key = configKey(customerId);
  const value = JSON.stringify({ state, updatedAt: new Date().toISOString() });
  await prisma.config.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

/**
 * O robô pode responder? false se humano_ativo ou aguardando_humano.
 */
async function shouldBotRespond(customer) {
  const state = await getState(customer);
  return state === STATES.BOT_ATIVO;
}

/**
 * Nova mensagem do cliente com estado encerrado → volta ao bot.
 */
async function resetIfEncerrado(customer) {
  const state = await getState(customer);
  if (state === STATES.ENCERRADO) {
    await setState(customer.id, STATES.BOT_ATIVO);
    return true;
  }
  return false;
}

/**
 * Reseta encerrado se necessário e retorna { botMayRespond, state }.
 * Uma única chamada getState em vez de duas (resetIfEncerrado + shouldBotRespond).
 */
async function resetIfEncerradoAndShouldBotRespond(customer) {
  let state = await getState(customer);
  if (state === STATES.ENCERRADO) {
    await setState(customer.id, STATES.BOT_ATIVO);
    state = STATES.BOT_ATIVO;
  }
  return { botMayRespond: state === STATES.BOT_ATIVO, state };
}

module.exports = {
  STATES,
  getState,
  getStatesForCustomers,
  setState,
  shouldBotRespond,
  resetIfEncerrado,
  resetIfEncerradoAndShouldBotRespond,
};
