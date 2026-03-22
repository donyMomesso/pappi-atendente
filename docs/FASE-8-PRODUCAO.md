# Fase 8 — Produção e Envs

## Arquivos alterados

| Arquivo | Alteração |
|---------|-----------|
| `.env.example` | Comentários sobre service role e fallback |
| `render.yaml` | Vars Supabase, USE_STAFF_AUTH, ALLOW_API_KEY_FALLBACK, APP_URL, migrate deploy |

## Variáveis de ambiente (produção)

### Obrigatórias para auth privada

| Variável | Descrição |
|----------|-----------|
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_ANON_KEY` | Chave anônima (pode ir no frontend) |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave de serviço — **nunca** no frontend |
| `APP_URL` | `https://app.pappiatendente.com.br` |
| `API_URL` | `https://api.pappiatendente.com.br` |
| `CORS_ORIGIN` | `https://app.pappiatendente.com.br` |

### Temporárias (integrações técnicas)

| Variável | Uso |
|----------|-----|
| `ADMIN_API_KEY` | Integrações técnicas (não login humano) |
| `ATTENDANT_API_KEY` | Integrações técnicas (não login humano) |

### Controle

| Variável | Valor | Efeito |
|----------|-------|--------|
| `USE_STAFF_AUTH` | `true` | Painel exige login e-mail/senha |
| `ALLOW_API_KEY_FALLBACK` | `false` | Não aceita API key como login humano |

## Supabase

1. **Desabilitar signup público**: Authentication → Providers → Email → "Enable Email Signup" = OFF  
2. **Redirect URLs**: adicionar `https://app.pappiatendente.com.br` e `https://app.pappiatendente.com.br/reset-password`  
3. **Site URL**: `https://app.pappiatendente.com.br`

## CORS e cookies

- CORS configurado em `src/app.js` com `CORS_ORIGIN`
- Frontend e API em domínios diferentes: `app.*` e `api.*`
- Sessão Supabase armazenada no cliente (localStorage/sessionStorage) — não usa cookies de sessão do servidor

## Checklist de deploy (Render)

1. [ ] Criar/obter projeto Supabase e obter URL e chaves  
2. [ ] Configurar Supabase: desabilitar signup, configurar redirects  
3. [ ] Definir no Render: `SUPABASE_*`, `APP_URL`, `API_URL`, `CORS_ORIGIN`  
4. [ ] Executar migrations: `npx prisma migrate deploy` (ou via build)  
5. [ ] Criar primeiro admin via seed ou API  
6. [ ] Apontar DNS: `app.pappiatendente.com.br` e `api.pappiatendente.com.br`  
7. [ ] Usar HTTPS em produção

## Segurança

- `SUPABASE_SERVICE_ROLE_KEY` apenas no backend (Render env)  
- Frontend usa apenas `SUPABASE_ANON_KEY` (via `/auth/config`)  
- API keys usadas só para integrações técnicas, não para login humano
