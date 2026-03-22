# FASE 4 — Middlewares

## O que foi alterado

Separação entre autenticação humana (sessão Supabase) e técnica (API key).
Criação de authorization.middleware.js e integração com auth.service.

## Arquivos

| Ação | Arquivo |
|------|---------|
| Editado | `src/middleware/auth.middleware.js` |
| Criado | `src/middleware/authorization.middleware.js` |

## auth.middleware.js

### Fluxo

1. **authBySession**: usa auth.service.verifySession (Supabase JWT → StaffUser).
2. **authBySessionFallback**: quando Supabase não configurado, tenta verificação direta.
3. **authByApiKey**: integrações técnicas (ADMIN_API_KEY, ATTENDANT_API_KEY).
4. **requireStaffAuth**: tenta sessão, depois fallback, depois API key (se ALLOW_API_KEY_FALLBACK).
5. **authAdmin**: idem, mas exige role admin.

### Separação

- **Humano**: sessão Supabase → req.staffUser, req.role, req.tenantScope.
- **Técnico**: API key → req.staffUser sintético, req.role, req.tenantScope.

## authorization.middleware.js

| Middleware | Descrição |
|------------|-----------|
| `requireAuth` | Exige req.staffUser |
| `requireRole(...roles)` | Exige uma das roles (admin, manager, attendant) |
| `requireTenantAccess` | Admin passa; manager/attendant só acessam próprio tenant |
| `requirePermission(...permissions)` | Exige canViewOrders, canSendMessages, etc. |

### Regras

- **Admin**: acessa qualquer tenant.
- **Manager/Attendant**: só acessam req.tenantScope (próprio tenant).

## Compatibilidade

- `requireRole` e `requireTenantAccess` continuam exportados por auth.middleware (re-export de authorization).
- Código que usa auth.middleware não precisa mudar.
