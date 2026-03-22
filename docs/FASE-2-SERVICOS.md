# Fase 2 — Camada de Serviços

## Arquivos

| Arquivo | Descrição |
|---------|-----------|
| `src/services/staff-user.service.js` | CRUD e validações de StaffUser |
| `src/services/audit-log.service.js` | Função central de auditoria |
| `src/services/audit.service.js` | Re-exporta `audit-log.service` (compatibilidade) |

## staff-user.service.js

### Funções

- **listStaffUsers(filters)** — Lista com filtros `{ tenantId, role, active }`
- **findByEmail(email)** — Busca por e-mail normalizado
- **findByAuthUserId(authUserId)** — Busca por ID do Supabase Auth
- **createStaffUser(data, invitedBy)** — Cria usuário (valida role e tenant)
- **updateStaffUser(id, data)** — Atualiza campos permitidos
- **activateStaffUser(id)** — Ativa
- **deactivateStaffUser(id, currentStaffUserId)** — Desativa (evita auto-desativação)
- **updateLastLogin(id)** — Atualiza `lastLoginAt`
- **validateRole(role)** — Valida admin | manager | attendant
- **validateTenantRequired(role, tenantId)** — Manager/attendant exigem tenant

### Exemplos

```js
const staffUser = require("./services/staff-user.service");

// Listar
const users = await staffUser.listStaffUsers({ tenantId: "tenant-pappi-001", active: true });

// Buscar
const u = await staffUser.findByAuthUserId("uuid-do-supabase");
const u2 = await staffUser.findByEmail("admin@empresa.com");

// Criar (authUserId vem do Supabase após createUser)
await staffUser.createStaffUser({
  authUserId: "...",
  email: "novo@empresa.com",
  name: "Novo Usuário",
  role: "attendant",
  tenantId: "tenant-pappi-001",
}, "Admin");

// Validar
staffUser.validateRole("manager");       // ok
staffUser.validateRole("invalid");       // throws
staffUser.validateTenantRequired("attendant", null); // throws
```

## audit-log.service.js

### logAction(opts)

```js
const { logAction } = require("./services/audit-log.service");

await logAction({
  action: "login_success",
  resourceType: "staff_user",
  resourceId: staffUser.id,
  userId: staffUser.id,
  tenantId: staffUser.tenantId,
  metadata: { email: staffUser.email },
  ip: req.ip,
  userAgent: req.headers["user-agent"],
});

await logAction({
  action: "login_denied",
  resourceType: "staff_user",
  metadata: { email: "tentativa@exemplo.com", reason: "user_not_found" },
  ip: req.ip,
});
```

### Ações sugeridas

- `login_success`, `login_denied`
- `staff_user_created`, `staff_user_updated`, `staff_user_activated`, `staff_user_deactivated`
- `reset_password_requested`, `staff_user_password_reset`
