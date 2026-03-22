# FASE 2 — Camada de Serviços

## O que foi alterado

Criação da lógica interna de usuários (StaffUser) e auditoria (AuditLog).
O painel continua funcionando como antes; os serviços ficam disponíveis para as rotas e middlewares.

## Arquivos

| Ação | Arquivo |
|------|---------|
| Criado | `src/services/staff-user.service.js` |
| Criado | `src/services/audit-log.service.js` |
| Editado | `src/services/audit.service.js` (passa a re-exportar audit-log.service) |

## staff-user.service.js

### Funções

| Função | Descrição |
|--------|-----------|
| `validateRole(role)` | Lança se role inválida (admin, manager, attendant) |
| `validateTenantRequired(role, tenantId)` | Lança se manager/attendant sem tenant |
| `listStaffUsers(filters)` | Lista com filtros tenantId, role, active |
| `findByEmail(email)` | Busca por email normalizado |
| `findByAuthUserId(authUserId)` | Busca por Supabase auth.users.id |
| `createStaffUser(data, invitedBy)` | Cria com validações |
| `updateStaffUser(id, data, currentUserId)` | Atualiza campos permitidos |
| `activateStaffUser(id)` | Ativa |
| `deactivateStaffUser(id, currentStaffUserId)` | Desativa (impede auto-desativação) |
| `updateLastLogin(id)` | Atualiza lastLoginAt |

### Exemplo de uso

```js
const staffUser = require("../services/staff-user.service");

// Listar usuários
const users = await staffUser.listStaffUsers({ tenantId: "tenant-1", active: true });

// Buscar por authUserId (após login Supabase)
const u = await staffUser.findByAuthUserId(session.user.id);
if (!u || !u.active) return res.status(403).json({ error: "Usuário não autorizado" });

// Criar (após criar no Supabase Auth)
await staffUser.createStaffUser({
  authUserId: authUser.id,
  email: "joao@empresa.com",
  name: "João Silva",
  role: "attendant",
  tenantId: "tenant-pappi-001",
  active: true,
}, req.staffUser?.name);
```

## audit-log.service.js

### Função

| Função | Descrição |
|--------|-----------|
| `logAction(opts)` | Registra ação em AuditLog |

### Parâmetros

- `action` (obrigatório): login_success, staff_user_created, etc.
- `resourceType`, `resourceId`: opcionais
- `userId`, `tenantId`: opcionais
- `metadata`: objeto (serializado como JSON)
- `ip`, `userAgent`: opcionais

### Exemplo de uso

```js
const auditLog = require("../services/audit-log.service");

await auditLog.logAction({
  action: "login_success",
  resourceType: "staff_user",
  resourceId: staffUser.id,
  userId: staffUser.id,
  tenantId: staffUser.tenantId,
  metadata: { email: staffUser.email },
  ip: req.ip,
  userAgent: req.headers["user-agent"],
});
```

## Compatibilidade

- **audit.service.js** continua exportando `logAction`; código que usa `require("./audit.service")` não precisa mudar.
- Novos serviços não alteram rotas nem middlewares existentes.
- Rotas podem migrar gradualmente para `staff-user.service` e `audit-log.service`.

## Organização

- `staff-user.service.js`: regras de negócio de StaffUser
- `audit-log.service.js`: registro de auditoria
- `audit.service.js`: wrapper para compatibilidade
