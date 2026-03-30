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

// Em dev (nodemon/hot reload), reutiliza via global para não recriar pool.
// Em prod, instância única por processo é suficiente (sem depender de global).
const prisma = isDev ? (globalForPrisma.__prisma ||= buildPrismaClient()) : buildPrismaClient();

// Alerta operacional: em produção, configure pool no DATABASE_URL para aguentar rajadas.
// Ex.: postgresql://.../db?connection_limit=20&pool_timeout=15
try {
  const url = process.env.DATABASE_URL || "";
  if (!isDev && url && !globalForPrisma.__prismaPoolWarned) {
    globalForPrisma.__prismaPoolWarned = true;
    if (!/connection_limit=\d+/i.test(url) || !/pool_timeout=\d+/i.test(url)) {
      // eslint-disable-next-line no-console
      console.warn(
        "[prisma] Sugestão: adicione `?connection_limit=20&pool_timeout=15` ao DATABASE_URL em produção para evitar gargalos.",
      );
    }
  }
} catch {}

module.exports = prisma;
