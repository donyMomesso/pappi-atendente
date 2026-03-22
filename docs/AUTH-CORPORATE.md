# Autenticação Corporativa — Pappi Atendente

## Visão geral

Sistema fechado, sem cadastro público. Apenas usuários previamente autorizados em `staff_users` podem acessar o painel.

## Arquitetura

- **Supabase Auth**: login e-mail/senha, reset de senha
- **staff_users**: tabela de autorização (quem pode acessar)
- **audit_logs**: registro de ações sensíveis

## Configuração

### Variáveis de ambiente

```env
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

APP_URL=https://app.pappiatendente.com.br
API_URL=https://api.pappiatendente.com.br
CORS_ORIGIN=https://app.pappiatendente.com.br

USE_STAFF_AUTH=true
ALLOW_API_KEY_FALLBACK=false
```

### Supabase Dashboard

1. **Desabilitar signup público**: Authentication → Providers → Email → Disable "Enable sign ups"
2. **Configurar redirect URLs**: Authentication → URL Configuration → adicionar `https://app.pappiatendente.com.br`

## Migração

```bash
# Aplicar schema (staff_users, audit_logs)
psql "$DATABASE_URL" -f prisma/migrations/20250320100000_add_staff_auth/migration.sql

# Ou
npx prisma db push
```

## Primeiro admin

Criar manualmente no Supabase Auth + staff_users:

```sql
-- 1. Criar usuário no Supabase (via Dashboard ou Admin API)
-- 2. Inserir em staff_users:

INSERT INTO staff_users (id, "authUserId", email, name, role, active, "canManageUsers")
SELECT gen_random_uuid()::text, '<UUID do auth.users>', 'admin@empresa.com', 'Admin', 'admin', true, true;
```

Ou use o script:

```bash
node scripts/create-staff-admin.js admin@empresa.com SenhaSegura123
```

## Roles

| Role      | Acesso |
|-----------|--------|
| admin     | Total; gestão de usuários, tenants, configurações |
| manager   | Tenant vinculado; operação, relatórios, config operacional |
| attendant | Atendimento, pedidos, alertas; sem config crítica |

## Fluxos

### Login
1. Usuário digita e-mail e senha
2. Frontend: `supabase.auth.signInWithPassword()`
3. Frontend: GET /auth/me com Bearer token
4. Backend: valida JWT, busca staff_user; se ativo, retorna sessão

### Reset de senha
1. POST /auth/reset-password com e-mail
2. Backend verifica se e-mail existe em staff_users (ativo)
3. Supabase envia e-mail com link

### Criar usuário (admin)
1. POST /dash/staff-users com email, password, name, role, tenantId
2. Backend cria em Supabase Auth + staff_users
3. Registra em audit_logs

## Rotas

| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| GET | /auth/config | — | Config pública (Supabase URL, anon key) |
| GET | /auth/me | Bearer | Dados do usuário logado |
| POST | /auth/reset-password | — | Solicita reset (e-mail) |
| GET | /dash/staff-users | admin | Lista usuários |
| POST | /dash/staff-users | admin | Cria usuário |
| PATCH | /dash/staff-users/:id | admin | Edita usuário |
| POST | /dash/staff-users/:id/activate | admin | Ativa |
| POST | /dash/staff-users/:id/deactivate | admin | Desativa |
| POST | /dash/staff-users/:id/reset-password | admin | Define nova senha |
| GET | /dash/audit-logs | admin | Lista logs |

## Checklist de deploy

- [ ] SUPABASE_URL e keys configurados
- [ ] Signup público desabilitado no Supabase
- [ ] Tabelas staff_users e audit_logs criadas
- [ ] Primeiro admin criado
- [ ] CORS_ORIGIN com domínio do app
- [ ] USE_STAFF_AUTH=true
- [ ] ALLOW_API_KEY_FALLBACK=false (produção)

## Migração do modelo antigo

| Fase | Ação |
|------|------|
| 1 | Configurar Supabase, criar staff_users, primeiro admin |
| 2 | ALLOW_API_KEY_FALLBACK=true temporariamente |
| 3 | Migrar usuários (criar em staff_users) |
| 4 | ALLOW_API_KEY_FALLBACK=false; remover uso de API key no painel |
