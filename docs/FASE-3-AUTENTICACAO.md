# Fase 3 — Autenticação Privada

## Arquivo

`src/services/auth.service.js`

## Estratégia

- **Login**: o frontend usa Supabase Client (`signInWithPassword`). O backend não recebe senha.
- **Validação**: o frontend envia o `access_token` (JWT) nas requisições. O backend chama `verifySession(token)`.
- **Autorização**: `verifySession` valida o JWT no Supabase e busca o usuário em `StaffUser`. Só autoriza se existir e `active=true`.
- **Sem signup**: não há endpoint de cadastro. Usuários são criados apenas por admins via `admin/users`.

## Funções

### verifySession(accessToken, opts)

Valida o token e retorna o StaffUser autorizado.

```js
const auth = require("./services/auth.service");

const result = await auth.verifySession(req.headers.authorization?.replace("Bearer ", ""), {
  ip: req.ip,
  userAgent: req.headers["user-agent"],
});

if (result) {
  req.staffUser = result.staffUser;
  req.role = result.staffUser.role;
  req.tenantId = result.staffUser.tenantId;
} else {
  return res.status(401).json({ error: "unauthorized" });
}
```

### requestPasswordReset(email, opts)

Só envia e-mail de reset se o usuário existir em StaffUser e estiver ativo.

```js
const { ok, message } = await auth.requestPasswordReset(req.body.email, {
  ip: req.ip,
  userAgent: req.headers["user-agent"],
});
```

## Fluxo fechado

1. Usuário previamente criado por admin → existe em StaffUser e Supabase Auth.
2. Login no frontend → Supabase `signInWithPassword` → retorna sessão com `access_token`.
3. Requisições ao backend → header `Authorization: Bearer <access_token>`.
4. Backend → `verifySession` → Supabase valida JWT → busca StaffUser → verifica `active` → autoriza ou nega.

## Auditoria

- `login_success` — login autorizado
- `login_denied` — token inválido, usuário não autorizado ou inativo
- `reset_password_requested` — e-mail de reset enviado
- `reset_password_denied` — e-mail não encontrado ou usuário inativo
