const log = require("../lib/logger").child({ service: "http" });
const metrics = require("../lib/metrics");

function requestLoggerMiddleware(req, res, next) {
  const start = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - start;
    metrics.observeHttpRequest({ method: req.method, route: req.route?.path || req.path || req.originalUrl || "unknown", statusCode: res.statusCode, durationMs });
    log.info({ requestId: req.requestId, method: req.method, path: req.originalUrl || req.url, statusCode: res.statusCode, durationMs, tenantId: req.tenantId || req.headers["x-tenant-id"] || null }, "HTTP request");
  });
  next();
}

module.exports = { requestLoggerMiddleware };
