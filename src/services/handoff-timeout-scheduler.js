// src/services/handoff-timeout-scheduler.js
// Devolve ao robô clientes em humano_ativo após X min de inatividade.

const prisma = require("../lib/db");
const ENV = require("../config/env");
const { releaseHandoff } = require("./customer.service");
const convState = require("./conversation-state.service");

const INTERVAL_MS = 2 * 60 * 1000; // roda a cada 2 min
let running = false;

async function run() {
  const timeoutMin = ENV.CONVERSATION_HANDOFF_TIMEOUT_MIN;
  if (!timeoutMin || timeoutMin < 1) return;

  const since = new Date(Date.now() - timeoutMin * 60 * 1000);
  const customers = await prisma.customer.findMany({
    where: { handoff: true, lastInteraction: { lt: since } },
    select: { id: true, phone: true, claimedBy: true },
  });

  for (const c of customers) {
    const state = await convState.getState(c);
    if (state !== convState.STATES.HUMANO_ATIVO) continue;
    try {
      await releaseHandoff(c.id);
      console.log(`[HandoffTimeout] ${c.phone} devolvido ao robô (inatividade > ${timeoutMin} min)`);
    } catch (err) {
      console.warn(`[HandoffTimeout] Erro ao devolver ${c.phone}:`, err.message);
    }
  }
}

function start() {
  if (running) return;
  const timeoutMin = ENV.CONVERSATION_HANDOFF_TIMEOUT_MIN;
  if (!timeoutMin || timeoutMin < 1) return;
  running = true;
  console.log(`[HandoffTimeout] Scheduler iniciado (${timeoutMin} min de inatividade)`);
  setInterval(run, INTERVAL_MS);
  setTimeout(run, 30_000);
}

module.exports = { start, run };
