const fs = require("fs");
const path = require("path");
const files = ["src/middleware/webhook-signature.middleware.js","src/services/cardapio-double-check.service.js","src/middleware/request-context.middleware.js","src/middleware/request-logger.middleware.js","src/lib/metrics.js","src/services/idempotency.service.js","src/routes/enterprise.routes.js","src/bootstrap/worker.js"];
const missing = files.filter((file) => !fs.existsSync(path.join(process.cwd(), file)));
if (missing.length) { console.error("Arquivos faltando:
" + missing.join("
")); process.exit(1); }
console.log("Smoke enterprise OK");
