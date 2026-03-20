// src/lib/db.js
// Singleton do PrismaClient — uma única conexão reutilizada em todo o projeto.
// NUNCA instancie PrismaClient diretamente em outros arquivos.

const { PrismaClient } = require("@prisma/client");

const globalForPrisma = globalThis;

if (!globalForPrisma.__prisma) {
  globalForPrisma.__prisma = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

const prisma = globalForPrisma.__prisma;

module.exports = prisma;
