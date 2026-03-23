// src/app.js
// MELHORIA: inicializa scheduler de retry do CW

require("dotenv").config();
const express = require("express");
const path = require("path");
const prisma = require("./lib/db");

const webhookRoutes = require("./routes/webhook.routes");
const ordersRoutes = require("./routes/orders.routes");
const internalRoutes = require("./routes/internal.routes");
const adminRoutes = require("./routes/admin.routes");
const diagRoutes = require("./routes/diag.routes");
const dashRoutes = require("./routes/dashboard.routes");

// ── Baileys (WhatsApp interno) ────────────────────────────────
try {
  const baileys = require("./services/baileys.service");
  baileys.initAll().catch((e) => console.warn("[Baileys] initAll error:", e.message));
} catch (e) {
  console.warn("[Baileys] módulo não disponível:", e.message);
}

// ── Agendador de retenção/reengajamento ───────────────────────
try {
  const retentionSvc = require("./services/retention.service");
  retentionSvc.startScheduler();
} catch (e) {
  console.warn("[Retention] scheduler error:", e.message);
}

// ── Agendador de retry de pedidos CW ─────────────────────────
try {
  const cwRetrySvc = require("./services/cw-retry.service");
  cwRetrySvc.startScheduler();
} catch (e) {
  console.warn("[CW-Retry] scheduler error:", e.message);
}

// ── Monitor de atraso de pedidos (em_producao > 60 min) ───────
try {
  const orderDelayMonitor = require("./services/order-delay-monitor.service");
  orderDelayMonitor.startScheduler();
} catch (e) {
  console.warn("[OrderDelay] scheduler error:", e.message);
}

// ── Agendador "Me avise quando abrir" — disparo às 18h ────────
try {
  const aviseScheduler = require("./services/avise-abertura-scheduler");
  aviseScheduler.startScheduler();
} catch (e) {
  console.warn("[AviseAbertura] scheduler error:", e.message);
}

// ── Timeout de handoff (devolve ao robô após inatividade) ─────
try {
  const handoffTimeout = require("./services/handoff-timeout-scheduler");
  handoffTimeout.start();
} catch (e) {
  console.warn("[HandoffTimeout] scheduler error:", e.message);
}

const ENV = require("./config/env");
const app = express();

// CORS para app em domínio separado (ou * para aceitar qualquer origem)
// Em dev, aceita localhost e IPs privados (acesso na rede)
const isDev = ENV.NODE_ENV === "development" || !ENV.NODE_ENV;
let corsOrigins = ENV.CORS_ORIGIN ? ENV.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean) : [];
if (isDev && corsOrigins.length === 0) {
  corsOrigins = ["*"]; // dev sem CORS_ORIGIN = aceita qualquer origem (incl. 192.168.x.x)
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
      else if (hasPappiDomain && /^https:\/\/([a-z0-9-]+\.)?pappiatendente\.com\.br$/i.test(origin))
        allowOrigin = true;
    }
    if (allowOrigin && origin) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, x-attendant-key, x-tenant-id");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
}

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "../public")));

// Saúde
app.get("/health", async (_req, res) => {
  const ENV = require("./config/env");
  const status = {
    ok: true,
    version: "3.1.0",
    db: "ok",
    adminKeyConfigured: !!(ENV.ADMIN_API_KEY && ENV.ADMIN_API_KEY.length > 0),
  };
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    status.db = "error";
    status.ok = false;
  }
  res.status(status.ok ? 200 : 503).json(status);
});

// Política de privacidade
app.get("/privacy", (_req, res) => res.sendFile(path.join(__dirname, "../public/privacy.html")));

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
