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
if (ENV.CORS_ORIGIN) {
  let origins = ENV.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);
  // Inclui automaticamente domínio raiz pappiatendente.com.br (e www) quando houver app.pappiatendente
  const addRoot = (url) => {
    try {
      const u = new URL(url);
      if (u.hostname.endsWith(".pappiatendente.com.br")) {
        origins.push("https://pappiatendente.com.br");
        origins.push("https://www.pappiatendente.com.br");
      }
    } catch (_) {}
  };
  origins.forEach(addRoot);
  origins = [...new Set(origins)];
  if (origins.length) {
    const allowAny = origins.includes("*");
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (allowAny && origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
      } else if (origin && origins.some((o) => o !== "*" && origin === o)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
      }
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, x-attendant-key, x-tenant-id");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      if (req.method === "OPTIONS") return res.sendStatus(204);
      next();
    });
  }
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
