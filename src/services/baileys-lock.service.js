// src/services/baileys-lock.service.js
// Lock por instância + ambiente — evita dois processos assumirem a mesma sessão (440).

const prisma = require("../lib/db");
const ENV = require("../config/env");
const log = require("../lib/logger").child({ service: "baileys-lock" });

const LOCK_PREFIX = "baileys:lock:";
const TTL_MS = ENV.BAILEYS_LOCK_TTL_MS || 60_000;

function lockKey(instanceId) {
  const env = ENV.APP_ENV || "local";
  return `${LOCK_PREFIX}${env}:${instanceId}`;
}

function ownerId() {
  const host = ENV.BAILEYS_HOSTNAME || require("os").hostname();
  const pid = process.pid;
  return `${host}:${pid}`;
}

/**
 * Tenta adquirir o lock para a instância.
 * @returns {Promise<boolean>} true se adquiriu, false se outro processo é dono
 */
async function acquireLock(instanceId) {
  const key = lockKey(instanceId);
  const owner = ownerId();
  const now = Date.now();

  try {
    const row = await prisma.config.findUnique({ where: { key } });
    if (!row?.value) {
      await prisma.config.create({
        data: { key, value: JSON.stringify({ owner, ts: now }) },
      });
      log.info({ instanceId, owner, appEnv: ENV.APP_ENV }, "Lock adquirido (primeiro)");
      return true;
    }

    const data = JSON.parse(row.value);
    const age = now - (data.ts || 0);
    if (age > TTL_MS) {
      await prisma.config.update({
        where: { key },
        data: { value: JSON.stringify({ owner, ts: now }) },
      });
      log.info(
        { instanceId, owner, prevOwner: data.owner, ageMs: age },
        "Lock adquirido (TTL expirado, anterior abandonado)",
      );
      return true;
    }

    if (data.owner === owner) {
      await prisma.config.update({
        where: { key },
        data: { value: JSON.stringify({ owner, ts: now }) },
      });
      log.debug({ instanceId, owner }, "Lock renovado (heartbeat)");
      return true;
    }

    log.warn(
      {
        instanceId,
        owner,
        currentOwner: data.owner,
        ageMs: age,
        lockKey: key,
        pid: process.pid,
      },
      "Lock recusado — outro processo ativo. Não iniciar Baileys.",
    );
    return false;
  } catch (err) {
    // Fail-closed: sem lock no banco não assumimos a sessão (evita 440 / disputa silenciosa).
    log.error(
      { instanceId, owner, lockKey: key, pid: process.pid, err },
      "Erro ao adquirir lock — Baileys NÃO será iniciado neste processo até o DB responder",
    );
    return false;
  }
}

/**
 * Libera o lock (chamar ao desconectar intencionalmente).
 */
async function releaseLock(instanceId) {
  const key = lockKey(instanceId);
  const owner = ownerId();

  try {
    const row = await prisma.config.findUnique({ where: { key } });
    if (row?.value) {
      const data = JSON.parse(row.value);
      if (data.owner === owner) {
        await prisma.config.delete({ where: { key } });
        log.info({ instanceId, owner }, "Lock liberado");
      }
    }
  } catch (err) {
    log.warn({ instanceId, err }, "Erro ao liberar lock");
  }
}

/**
 * Atualiza heartbeat (manter lock vivo).
 */
async function heartbeat(instanceId) {
  const key = lockKey(instanceId);
  const owner = ownerId();
  const now = Date.now();

  try {
    const row = await prisma.config.findUnique({ where: { key } });
    if (row?.value) {
      const data = JSON.parse(row.value);
      if (data.owner === owner) {
        await prisma.config.update({
          where: { key },
          data: { value: JSON.stringify({ owner, ts: now }) },
        });
      }
    }
  } catch (_) {}
}

module.exports = { acquireLock, releaseLock, heartbeat, ownerId };
