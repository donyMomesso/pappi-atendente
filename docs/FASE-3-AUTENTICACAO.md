# FASE 3 — Autenticação Privada

## O que foi alterado

Criação do serviço de autenticação que integra Supabase Auth com StaffUser.
Login humano passa a ser validado contra a tabela interna; sem signup público.

## Arquivos

| Ação | Arquivo |
|------|---------|
| Criado | `src/services/auth.service.js` |

## auth.service.js

### Funções

| Função | Descrição |
|--------|-----------|
| `verifySessionAndAuthorize(accessToken, ctx)` | Valida JWT, carrega StaffUser, checa ativo, atualiza lastLoginAt, registra auditoria |
| `requestPasswordReset(email, ctx)` | Só permite reset se StaffUser existir e ativo; dispara email e registra |
| `isAuthConfigured()` | Indica se Supabase está configurado |

### Regras

- **Sem signup público**: criação de usuário é apenas via admin (Supabase Admin API).
- **Usuário só entra se**:
  1. Token Supabase válido
  2. authUserId existe em StaffUser
  3. StaffUser.active = true
- **Usuário inativo**: bloqueado; `login_denied` registrado com reason `user_inactive`.
- **Usuário não em StaffUser**: bloqueado; `login_denied` com reason `user_not_authorized`.
- **lastLoginAt**: atualizado em login bem-sucedido.
- **Auditoria**: login_success, login_denied, reset_password_requested, reset_password_denied.

### Fluxo fechado

1. **Login**: cliente usa Supabase `signInWithPassword` → recebe access_token → envia Bearer na API.
2. **API**: auth.service.verifySessionAndAuthorize(token) → StaffUser carregado ou null.
3. **Reset**: cliente chama POST /auth/reset-password → auth.service.requestPasswordReset → Supabase envia email.

### Uso do Supabase

- **Backend**: usa `SUPABASE_SERVICE_ROLE_KEY` para `verifyToken`, `createUser`, `resetPasswordForEmail`.
- **Frontend**: usa `SUPABASE_ANON_KEY`; signup desativado no Dashboard do Supabase.
- **Nunca** expor `SERVICE_ROLE_KEY` no frontend.

## Compatibilidade

- Middleware existente continua usando supabase-auth.service e prisma diretamente.
- auth.service pode ser adotado gradualmente pelo middleware em FASE 4.
- Rotas de auth podem passar a usar auth.service em vez de lógica inline.
