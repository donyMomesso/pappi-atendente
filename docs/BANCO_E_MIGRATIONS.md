# Banco e Migrations

## Prisma

- ORM: Prisma 5
- Singleton: `src/lib/db.js`
- Schemas: `auth` (Supabase) e `public` (app)

## Fluxo recomendado

1. **Desenvolvimento:** `npx prisma db push`
2. **Produção:** `npx prisma migrate deploy`

## Antes de migrations estruturais

1. Fazer backup do banco
2. Testar migration em staging
3. Agendar janela de manutenção se necessário
4. Ter plano de rollback

## Comandos

| Comando | Uso |
|---------|-----|
| `npx prisma generate` | Gera client |
| `npx prisma db push` | Sincroniza schema (dev) |
| `npx prisma migrate deploy` | Aplica migrations (prod) |
| `npx prisma migrate dev --name xxx` | Cria nova migration |
| `npx prisma studio` | Interface visual |

## Backup

Ver `docs/ROTINA_BACKUP.md`.
