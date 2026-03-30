const express = require("express");
const ENV = require("../config/env");
const metrics = require("../lib/metrics");
const { getRedis } = require("../lib/redis");
const { requireAdminKey } = require("../middleware/auth.middleware");

const router = express.Router();

router.get("/metrics", async (req, res) => {
  if (ENV.METRICS_TOKEN) {
    const token = req.headers["x-metrics-token"] || req.query?.token;
    if (token !== ENV.METRICS_TOKEN) return res.status(401).json({ error: "unauthorized" });
  } else {
    const raw = req.headers["x-api-key"] || req.headers.authorization?.replace(/^Bearer\s+/i, "").trim();
    if (!ENV.ADMIN_API_KEY || raw !== ENV.ADMIN_API_KEY) return res.status(401).json({ error: "unauthorized" });
  }
  res.setHeader("Content-Type", metrics.register.contentType);
  return res.send(await metrics.getMetrics());
});

router.get("/enterprise/diagnostics", requireAdminKey, async (_req, res) => res.json({ ok: true, version: "3.2.0-enterprise", redisConfigured: !!ENV.REDIS_URL, redisStatus: getRedis()?.status || "disabled", queuesEnabled: !!ENV.REDIS_URL, metricsProtected: !!ENV.METRICS_TOKEN || !!ENV.ADMIN_API_KEY }));

module.exports = router;
