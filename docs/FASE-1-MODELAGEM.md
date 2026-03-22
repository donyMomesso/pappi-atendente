# Fase 1 — Modelagem e Banco

## O que foi alterado

- **prisma/schema.prisma**: Modelos `StaffUser` e `AuditLog` adicionados
- **prisma/migrations/20250320100000_add_staff_auth/migration.sql**: Migration criada

## StaffUser

| Campo       | Tipo      | Descrição                          |
|------------|-----------|------------------------------------|
| id         | String    | UUID gerado                        |
| authUserId | String    | ID do usuário no Supabase Auth     |
| tenantId   | String?   | Tenant (null para admin global)    |
| email      | String    | E-mail                             |
| name       | String    | Nome                               |
| role       | String    | admin \| manager \| attendant      |
| active     | Boolean   | Usuário ativo                      |
| invitedBy  | String?   | Quem convidou                      |
| lastLoginAt| DateTime? | Último login                       |
| createdAt  | DateTime  | Criação                            |
| updatedAt  | DateTime  | Atualização                        |

**Índices:** email, authUserId, tenantId, role, active, (tenantId, active)

## AuditLog

| Campo        | Tipo    | Descrição                |
|-------------|---------|--------------------------|
| id          | String  | UUID gerado              |
| tenantId    | String? | Tenant relacionado       |
| userId      | String? | ID do usuário            |
| action      | String  | Ação realizada           |
| resourceType| String? | Tipo do recurso          |
| resourceId  | String? | ID do recurso            |
| metadata    | String? | JSON com detalhes        |
| ip          | String? | IP da requisição         |
| userAgent   | String? | User-Agent               |
| createdAt   | DateTime| Data/hora da ação        |

**Índices:** (tenantId, createdAt), (userId, createdAt), (action, createdAt)

## Compatibilidade

- As novas tabelas são criadas com `CREATE TABLE IF NOT EXISTS`
- Não altera tabelas existentes
- Relação `StaffUser` → `Tenant` com `ON DELETE SET NULL`
- O projeto segue funcionando com a autenticação atual

## Como aplicar

```bash
# Opção 1: Migration manual
psql "$DATABASE_URL" -f prisma/migrations/20250320100000_add_staff_auth/migration.sql

# Opção 2: Prisma (se o schema estiver alinhado)
npx prisma db push
```
