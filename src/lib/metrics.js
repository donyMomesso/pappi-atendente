const client = require("prom-client");

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestsTotal = new client.Counter({ name: "pappi_http_requests_total", help: "Total de requests HTTP", labelNames: ["method", "route", "status_code"], registers: [register] });
const httpRequestDurationMs = new client.Histogram({ name: "pappi_http_request_duration_ms", help: "Duração das requests HTTP em ms", labelNames: ["method", "route", "status_code"], buckets: [25,50,100,250,500,1000,2500,5000,10000], registers: [register] });
const webhookMessagesTotal = new client.Counter({ name: "pappi_webhook_messages_total", help: "Mensagens recebidas via webhook", labelNames: ["channel", "tenant_id", "result"], registers: [register] });

function normalizeRoute(route) { return String(route || "unknown").slice(0, 120); }
function observeHttpRequest({ method, route, statusCode, durationMs }) { const labels = { method: method || "GET", route: normalizeRoute(route), status_code: String(statusCode || 0) }; httpRequestsTotal.inc(labels); httpRequestDurationMs.observe(labels, Number(durationMs || 0)); }
function recordWebhookMessage({ channel, tenantId, result }) { webhookMessagesTotal.inc({ channel: channel || "unknown", tenant_id: tenantId || "unknown", result: result || "ok" }); }
async function getMetrics() { return register.metrics(); }

module.exports = { register, observeHttpRequest, recordWebhookMessage, getMetrics };
