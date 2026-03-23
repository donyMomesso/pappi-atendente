# Segurança — App Privado

## Princípios

- App interno da empresa, sem cadastro público
- Acesso restrito a usuários autorizados
- Chaves e tokens nunca expostos no frontend

## Autenticação

- **Admin:** `x-api-key` ou `Authorization: Bearer` com `ADMIN_API_KEY`
- **Atendente:** `x-api-key`, `x-attendant-key` ou sessão Supabase
- **Painel:** Sessão Supabase (Google OAuth) ou API key

## Produção

- `USE_STAFF_AUTH=true` — painel exige sessão
- `ALLOW_API_KEY_FALLBACK=false` — não aceitar API key como fallback no painel
- `CORS_ORIGIN` — apenas domínios autorizados (sem `*`)
- Helmet ativo (headers de segurança)
- `SUPABASE_SERVICE_ROLE_KEY` — nunca no frontend

## Rotas sensíveis

- `/admin/*` — requer admin
- `/dash/*` — requer atendente ou admin
- `/webhook` — validado pela Meta (verify_token)

## Rate limit

- Webhook: 60 msgs/min por telefone
- Gemini: 15/min por telefone
- Pedidos: 5/10min por telefone

## Boas práticas

- Rotacionar chaves periodicamente
- Usar HTTPS em produção
- Logs sem expor tokens ou senhas
- Backups do banco com acesso restrito
