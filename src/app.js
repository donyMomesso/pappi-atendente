// src/app.js
// Express app — rotas, middleware, CORS.
// Baileys e Jobs são iniciados via startup.js (index.js) ou processos separados (bootstrap/).

require("dotenv").config();
const express = require("express");
const path = require("path");
const helmet = require("helmet");
const prisma = require("./lib/db");

const webhookRoutes = require("./routes/webhook.routes");
const ordersRoutes = require("./routes/orders.routes");
const internalRoutes = require("./routes/internal.routes");
const adminRoutes = require("./routes/admin.routes");
const diagRoutes = require("./routes/diag.routes");
const dashRoutes = require("./routes/dashboard.routes");

const ENV = require("./config/env");
const app = express();

// Segurança: headers básicos (CSP desativado — app privado com Supabase/Google)
const isProd = ENV.NODE_ENV === "production";
if (isProd) {
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );
}

// CORS para app em domínio separado (ou * para aceitar qualquer origem)
// Em dev, aceita localhost e IPs privados (acesso na rede)
const isDev = ENV.NODE_ENV === "development" || !ENV.NODE_ENV;

let corsOrigins = ENV.CORS_ORIGIN
  ? ENV.CORS_ORIGIN.split(",")
      .map((o) => o.trim())
      .filter(Boolean)
  : [];

if (corsOrigins.length === 0) {
  corsOrigins = isDev ? ["*"] : [ENV.APP_URL].filter(Boolean);
}
if (corsOrigins.length > 0) {
  let origins = corsOrigins;
  const addRoot = (url) => {
    try {
      const u = new URL(url);
      if (u.hostname.endsWith(".pappiatendente.com.br")) {
        origins.push("https://pappiatendente.com.br");
        origins.push("https://www.pappiatendente.com.br");
        origins.push("https://app.pappiatendente.com.br");
      }
    } catch (_) {}
  };
  origins.forEach(addRoot);
  origins = [...new Set(origins)];
  const allowAny = origins.includes("*");
  const hasPappiDomain = origins.some((o) => o && o.includes("pappiatendente.com.br"));
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    let allowOrigin = false;
    if (allowAny && origin) {
      allowOrigin = true;
    } else if (origin) {
      if (origins.some((o) => o !== "*" && origin === o)) allowOrigin = true;
      // Aceita qualquer subdomínio *.pappiatendente.com.br (acesso fora da rede)
      else if (hasPappiDomain && /^https:\/\/([a-z0-9-]+\.)?pappiatendente\.com\.br$/i.test(origin)) allowOrigin = true;
    }
    if (allowOrigin && origin) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, x-api-key, x-attendant-key, x-tenant-id",
    );
    res.setHeader("Access-Control-Allow-Credentials", "true");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
}

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "../public")));

// Saúde (público para load balancer)
app.get("/health", async (req, res) => {
  const env = require("./config/env");
  const status = {
    ok: true,
    version: "3.1.0",
    db: "ok",
    env: env.NODE_ENV,
  };
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    status.db = "error";
    status.ok = false;
  }
  res.status(status.ok ? 200 : 503).json(status);
});

// Readiness (opcional: token para healthcheck privado)
app.get("/ready", async (req, res) => {
  const env = require("./config/env");
  if (env.HEALTHCHECK_TOKEN && req.query?.token !== env.HEALTHCHECK_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.json({ ok: true, db: "ok" });
  } catch {
    return res.status(503).json({ ok: false, db: "error" });
  }
});

// Política de privacidade
app.get("/privacy", (_req, res) => res.sendFile(path.join(__dirname, "../public/privacy.html")));
// Status / instabilidade WhatsApp (link enviado quando bot falha)
app.get("/status", (_req, res) => res.sendFile(path.join(__dirname, "../public/status.html")));

// Rotas
app.use("/auth", require("./routes/auth.routes"));
app.use("/", webhookRoutes);
app.use("/orders", ordersRoutes);
app.use("/internal", internalRoutes);
app.use("/admin/users", require("./routes/admin-users.routes"));
app.use("/admin", adminRoutes);
app.use("/dash/staff-users", require("./routes/staff-users.routes"));
app.use("/dash", dashRoutes);
app.use("/", diagRoutes);

app.use((_req, res) => res.status(404).json({ error: "not_found" }));

module.exports = app;
