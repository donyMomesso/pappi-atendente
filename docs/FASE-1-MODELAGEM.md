# FASE 1 — Modelagem e Banco

## O que foi alterado

Criação da base de autorização interna **sem alterar** a autenticação atual do painel.
O sistema continua funcionando com API key; as novas tabelas ficam disponíveis para as fases seguintes.

## Arquivos

| Ação | Arquivo |
|------|---------|
| Editado | `prisma/schema.prisma` |
| Criado | `prisma/migrations/20250320100000_add_staff_auth/migration.sql` |

## Modelo StaffUser

| Campo | Tipo | Descrição |
|-------|------|-----------|
| id | String | PK UUID |
| authUserId | String | UUID do auth.users (Supabase) — unique |
| tenantId | String? | null = admin global |
| email | String | E-mail do usuário |
| name | String | Nome exibido |
| role | String | admin \| manager \| attendant |
| active | Boolean | Se false, bloqueia acesso |
| invitedBy | String? | Quem convidou |
| lastLoginAt | DateTime? | Último login |
| createdAt | DateTime | |
| updatedAt | DateTime | |

Campos opcionais (fases futuras): canViewOrders, canSendMessages, canManageCoupons, canManageSettings, canManageUsers.

## Modelo AuditLog

| Campo | Tipo | Descrição |
|-------|------|-----------|
| id | String | PK UUID |
| tenantId | String? | |
| userId | String? | staff_user.id |
| action | String | login_success, staff_user_created, etc. |
| resourceType | String? | staff_user, tenant, etc. |
| resourceId | String? | |
| metadata | String? | JSON |
| ip | String? | |
| userAgent | String? | |
| createdAt | DateTime | |

## Índices

- **staff_users**: email, authUserId, tenantId, role, (tenantId, active)
- **audit_logs**: (tenantId, createdAt), (userId, createdAt), (action, createdAt)

## Compatibilidade

- **Não altera** tabelas existentes.
- **Não altera** rotas ou middleware.
- **Não altera** login atual (API key continua funcionando).
- Novas tabelas usam `CREATE TABLE IF NOT EXISTS` — seguro rodar mais de uma vez.

## Como aplicar

```bash
psql "$DATABASE_URL" -f prisma/migrations/20250320100000_add_staff_auth/migration.sql
```

Ou:

```bash
npx prisma db push
```

## Observações

- A tabela `tenants` deve existir (já existe no projeto).
- O schema `public` deve existir.
- Em Supabase/PostgreSQL, a migração deve rodar sem conflitos.
