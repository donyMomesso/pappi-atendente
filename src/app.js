// src/app.js
// MELHORIA: inicializa scheduler de retry do CW

require("dotenv").config();
const express = require("express");
const path = require("path");

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

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "../public")));

// Saúde
app.get("/health", (_req, res) => res.json({ ok: true, version: "3.1.0" }));

// Política de privacidade
app.get("/privacy", (_req, res) => res.sendFile(path.join(__dirname, "../public/privacy.html")));

// Rotas
app.use("/", webhookRoutes);
app.use("/orders", ordersRoutes);
app.use("/internal", internalRoutes);
app.use("/admin", adminRoutes);
app.use("/dash", dashRoutes);
app.use("/", diagRoutes);

app.use((_req, res) => res.status(404).json({ error: "not_found" }));

module.exports = app;
