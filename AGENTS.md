# AGENTS.md

## Cursor Cloud specific instructions

### Overview
Pappi Atendente is a Node.js (Express) WhatsApp customer-service/ordering system with Prisma ORM, PostgreSQL, and Socket.IO. See `README.md` for the full stack and script list.

### Services
| Service | Required | How to start |
|---|---|---|
| PostgreSQL 16 | Yes | `sudo docker compose up -d` (from repo root) |
| Node.js app | Yes | `npm run dev` (port 10000) |
| Redis | No | Only for BullMQ enterprise queues; app works without it |

### Database setup (first time only)
The Prisma schema has an `auth` schema with Supabase-generated tables that use column-reference defaults which `prisma db push` cannot create. For a fresh database:
1. `sudo docker compose up -d` — starts PostgreSQL with `docker/init-schemas.sql` (creates `auth` schema).
2. Run `docker/init-auth-dev.sql` inside PostgreSQL to create auth tables: `sudo docker cp docker/init-auth-dev.sql pappi-postgres:/tmp/init-auth-dev.sql && sudo docker exec pappi-postgres psql -U pappi -d pappi_dev -f /tmp/init-auth-dev.sql`
3. Apply migrations in order: iterate over `prisma/migrations/*/migration.sql` and run each via `psql`.
4. Mark all migrations as applied: `npx prisma migrate resolve --applied <migration_name>` for each.
5. `npx prisma generate` — generates the Prisma client.
6. `npm run db:seed` — optional, populates test data.

### Environment variables
The app auto-applies dev defaults in `NODE_ENV=development` via `src/lib/validate-env.js`:
- `DATABASE_URL=postgresql://pappi:pappi123@localhost:5432/pappi_dev`
- `ATTENDANT_API_KEY=pappi-atendente-2026`
- `ADMIN_API_KEY=pappi-admin-2026`
- `WEBHOOK_VERIFY_TOKEN=dev-webhook-token`

Set `BAILEYS_ENABLED=false` to skip WhatsApp QR connection in dev.

### Common commands
See `README.md` — scripts section. Key ones:
- `npm run dev` — dev server with hot-reload (port 10000)
- `npm test` — Jest unit tests (65/66 pass; `conversation.fuzz.test.js` fuzz test has a known failure)
- `npm run lint` — ESLint (pre-existing warnings in enterprise/bootstrap files; 1 parse error in `scripts/smoke-enterprise.js`)
- `npm run format:check` — Prettier check

### Auth for API calls
Use `x-api-key` header:
- Admin routes (`/admin/*`): `x-api-key: pappi-admin-2026`
- Dashboard routes (`/dash/*`): `x-api-key: pappi-atendente-2026`

### Gotchas
- Docker requires `sudo` in this environment (no rootless Docker).
- The `auth` schema tables mirror Supabase's auth system; they can't be created by Prisma's `db push` due to column-reference defaults. Use the SQL init script instead.
- The fuzz test `conversation.fuzz.test.js` has a known failure (3376 critical failures) — this is pre-existing.
