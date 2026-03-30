const { randomUUID } = require("crypto");
const requestContext = require("../lib/request-context");

function requestContextMiddleware(req, res, next) {
  const requestId = req.headers["x-request-id"] || randomUUID();
  const tenantId = req.headers["x-tenant-id"] || null;
  const context = { requestId, tenantId, path: req.originalUrl || req.url, method: req.method, startedAt: Date.now() };
  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  requestContext.run(context, () => next());
}

module.exports = { requestContextMiddleware };
