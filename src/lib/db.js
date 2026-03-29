// src/lib/db.js
// Singleton do PrismaClient — uma única conexão reutilizada em todo o projeto.
// NUNCA instancie PrismaClient diretamente em outros arquivos.

const { PrismaClient } = require("@prisma/client");

const globalForPrisma = globalThis;
const isDev = process.env.NODE_ENV !== "production";

function buildPrismaClient() {
  return new PrismaClient({
    log: isDev ? ["warn", "error"] : ["error"],
  });
}

const prisma = globalForPrisma.__pappiPrisma || buildPrismaClient();
if (!globalForPrisma.__pappiPrisma) globalForPrisma.__pappiPrisma = prisma;

function warnPoolConfig() {
  try {
    const url = process.env.DATABASE_URL || "";
    if (!url || globalForPrisma.__prismaPoolWarned) return;
    globalForPrisma.__prismaPoolWarned = true;
    const hasConnectionLimit = /(?:\?|&)connection_limit=\d+/i.test(url);
    const hasPoolTimeout = /(?:\?|&)pool_timeout=\d+/i.test(url);
    if (!hasConnectionLimit || !hasPoolTimeout) {
      // eslint-disable-next-line no-console
      console.warn(
        "[prisma] Sugestão de produção: adicione `?connection_limit=5&pool_timeout=30` ao DATABASE_URL do serviço web. " +
          "Em split runtime, use limites menores por processo para evitar esgotar o banco.",
      );
    }
  } catch {}
}

warnPoolConfig();

if (!globalForPrisma.__pappiPrismaHooksInstalled) {
  globalForPrisma.__pappiPrismaHooksInstalled = true;
  const close = async () => {
    try {
      await prisma.$disconnect();
    } catch {}
  };
  process.once("beforeExit", close);
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}

module.exports = prisma;
