// src/lib/logger.js
// Logger centralizado usando pino.
// Substitui console.log/warn/error espalhados pelo projeto.
// Em produção: JSON estruturado. Em dev: pretty-print.
//
// Uso:
//   const log = require('../lib/logger').child({ service: 'baileys' });
//   log.info('Conectado');
//   log.warn({ phone }, 'Número bloqueado');
//   log.error({ err }, 'Falha crítica');

const pino = require("pino");

const isDev = (process.env.NODE_ENV || "development") === "development";

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  // Em dev, formata de forma legível no terminal
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
        },
      }
    : {}),
  // Em produção: JSON puro para integração com Logtail, Datadog, etc.
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
  base: { env: process.env.NODE_ENV || "development" },
});

module.exports = logger;
