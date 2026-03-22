# FASE 5 — Rotas de Auth e Usuários

## O que foi alterado

Criação/atualização de rotas de autenticação e gestão de usuários.
Integração com auth.service, staff-user.service e audit-log.service.

## Arquivos

| Ação | Arquivo |
|------|---------|
| Editado | `src/routes/auth.routes.js` |
| Criado | `src/routes/admin-users.routes.js` |
| Editado | `src/app.js` |

## auth.routes.js

| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| GET | /auth/me | requireStaffAuth | Retorna usuário logado |
| POST | /auth/logout | requireStaffAuth | Confirma logout (cliente limpa sessão) |
| POST | /auth/reset-password | - | Solicita reset de senha por email |
| GET | /auth/config | - | Config pública (supabaseUrl, anonKey, useStaffAuth) |

### Payloads e respostas

**GET /auth/me** (Bearer token)

Resposta:
```json
{
  "id": "uuid",
  "authUserId": "uuid",
  "email": "joao@empresa.com",
  "name": "João Silva",
  "role": "attendant",
  "tenantId": "tenant-1",
  "active": true,
  "permissions": {
    "canViewOrders": true,
    "canSendMessages": true,
    "canManageCoupons": false,
    "canManageSettings": false,
    "canManageUsers": false
  }
}
```

**POST /auth/reset-password**
```json
{ "email": "joao@empresa.com" }
```
Resposta ok: `{ "ok": true, "message": "Se o e-mail existir..." }`
Resposta negada (400): `{ "error": "user_not_authorized", "message": "E-mail não encontrado ou não autorizado..." }`

## admin-users.routes.js

| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| GET | /admin/users | authAdmin | Lista usuários (filtros: tenantId, role, active) |
| POST | /admin/users | authAdmin | Cria usuário |
| PATCH | /admin/users/:id | authAdmin | Edita usuário |
| POST | /admin/users/:id/activate | authAdmin | Ativa |
| POST | /admin/users/:id/deactivate | authAdmin | Desativa |
| POST | /admin/users/:id/reset-password | authAdmin | Define nova senha |

### Exemplos

**POST /admin/users**
```json
{
  "email": "maria@empresa.com",
  "password": "senha123",
  "name": "Maria Santos",
  "role": "attendant",
  "tenantId": "tenant-pappi-001",
  "active": true
}
```

**PATCH /admin/users/:id**
```json
{
  "name": "Maria Santos Silva",
  "role": "manager",
  "tenantId": "tenant-pappi-001",
  "active": true
}
```

## Compatibilidade

- `/dash/staff-users` continua ativo (staff-users.routes.js) para o frontend atual.
- `/admin/users` é a rota nova conforme especificação.
- Ambas protegem com authAdmin (sessão ou API key fallback).
