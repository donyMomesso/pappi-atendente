# Ambientes — Pappi Atendente (App Privado)

Este documento descreve a separação de ambientes para operação em produção privada.

## Convenção de ambientes

| Ambiente | NODE_ENV | Uso | Banco |
|----------|----------|-----|-------|
| **development** | development | Desenvolvimento local | pappi_dev (local) |
| **staging** | staging | Homologação, testes | pappi_staging (separado) |
| **production** | production | Produção real | banco de produção |

## Regra crítica: isolamento

- **Nunca** misturar banco entre ambientes.
- **Nunca** usar mesma sessão Baileys em dev/staging e produção.
- Chaves e tokens devem ser diferentes por ambiente.

## Variáveis por ambiente

### Development

- `NODE_ENV=development`
- `DATABASE_URL` → localhost ou docker
- Chaves de teste (DEV_DEFAULTS em validate-env.js)
- `CORS_ORIGIN=*` ou localhost
- `SKIP_HOURS_CHECK=true` (opcional, para testes)

### Staging (homologação)

- `NODE_ENV=staging`
- `DATABASE_URL` → banco dedicado de staging
- Chaves específicas (não usar as de produção)
- `APP_URL`, `CORS_ORIGIN` → domínio staging
- `SKIP_HOURS_CHECK=true` recomendado para testes

### Production

- `NODE_ENV=production`
- `DATABASE_URL` → banco de produção
- Chaves fortes, únicas
- `WEB_CONCURRENCY=1` (obrigatório para Baileys)
- `CORS_ORIGIN` → apenas domínios autorizados
- `USE_STAFF_AUTH=true`, `ALLOW_API_KEY_FALLBACK=false`

## Arquivos de exemplo

| Arquivo | Uso |
|---------|-----|
| `.env.example` | Base, desenvolvimento |
| `.env.production.example` | Template produção |
| `.env.staging.example` | Template homologação |

Copie o exemplo adequado para `.env` e preencha os valores.

## Variáveis de processo

| Variável | Descrição | Produção |
|----------|-----------|----------|
| `RUN_JOBS` | Este processo executa schedulers | true (ou processo dedicado) |
| `RUN_BAILEYS` | Este processo inicia Baileys | true (ou processo dedicado) |
| `BAILEYS_ENABLED` | Baileys ativo no sistema | true |
| `WEB_CONCURRENCY` | Workers/processos HTTP | **1** (obrigatório) |

## Banco por ambiente

- **Dev:** `pappi_dev` (Postgres local ou Docker)
- **Staging:** `pappi_staging` (Supabase/Neon projeto separado)
- **Production:** banco dedicado de produção

Schemas `auth` e `public` devem existir em todos. Use `npx prisma db push` ou migrations.
