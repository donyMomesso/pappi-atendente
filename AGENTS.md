# AGENTS.md

## Cursor Cloud specific instructions

### Overview

Pappi Atendente is a Node.js + Express monolith serving a multi-tenant WhatsApp AI chatbot and order management system. All services (API, webhook, dashboard, WebSocket) run in a single process.

### Prerequisites

PostgreSQL must be running locally before starting the server. The update script installs it and starts it if needed.

### Database setup

After `npm install`, run:
```bash
sudo pg_ctlcluster 16 main start  # ensure PostgreSQL is running
sudo -u postgres psql -c "CREATE USER pappi WITH PASSWORD 'pappi123' SUPERUSER;" 2>/dev/null; true
sudo -u postgres psql -c "CREATE DATABASE pappi_dev OWNER pappi;" 2>/dev/null; true
sudo -u postgres psql -d pappi_dev -c "CREATE SCHEMA IF NOT EXISTS auth;" -c "CREATE SCHEMA IF NOT EXISTS public;"
```

Then create/update `.env` (see `.env.example`). Minimum required:
```
DATABASE_URL="postgresql://pappi:pappi123@localhost:5432/pappi_dev"
DIRECT_URL="postgresql://pappi:pappi123@localhost:5432/pappi_dev"
ATTENDANT_API_KEY="pappi-atendente-2026"
ADMIN_API_KEY="pappi-admin-2026"
WEBHOOK_VERIFY_TOKEN="dev-webhook-token"
PORT=10000
NODE_ENV=development
```

Then push the schema: `npx prisma db push`

### Running the dev server

```bash
npm run dev   # uses node --watch for auto-reload
```

Server listens on port 10000.

### Key gotchas

- The Prisma schema uses `multiSchema` preview feature with both `auth` and `public` schemas. The `auth` schema must exist in the database even though the app doesn't directly use it — Prisma needs it for schema sync.
- Admin API auth uses header `x-api-key` (not `x-admin-key`). Attendant dashboard auth also uses `x-api-key` or `x-attendant-key` or `Authorization: Bearer <key>`.
- ESLint + Prettier are configured. Run `npm run lint` and `npm run format:check`. Jest is available via `npm test`.
- In dev mode (`NODE_ENV=development` or unset), the server auto-applies default values for `DATABASE_URL`, `ATTENDANT_API_KEY`, `ADMIN_API_KEY`, and `WEBHOOK_VERIFY_TOKEN` if they're missing from `.env`. You can start the server with just `NODE_ENV=development` set.
- `npm run db:seed` populates the database with test tenant, customers, and a sample order.
- Baileys (WhatsApp QR) auto-starts on boot and generates QR codes — this is expected and non-blocking.
- `GEMINI_API_KEY` and `GOOGLE_MAPS_API_KEY` warnings at startup are normal in dev without those keys — the server runs fine without them.

### Useful endpoints for testing

- `GET /health` — health check with DB connectivity verification (no auth)
- `GET /admin/tenants` — list tenants (requires `x-api-key` admin header)
- `POST /admin/tenants` — create tenant (requires `x-api-key` admin header)
- `GET /dash/stats?tenant=<id>` — dashboard stats (requires attendant key)
- `GET /webhook?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<val>` — webhook verification
