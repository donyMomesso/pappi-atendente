# Fase 9 — Migração Final

## Checklist de migração

### Antes da migração

1. [ ] Supabase configurado (signup desabilitado)
2. [ ] Variáveis de ambiente de produção definidas
3. [ ] Migrations aplicadas (`npx prisma migrate deploy`)

### Criar primeiros usuários admin

```bash
ADMIN_EMAIL=seu@email.com ADMIN_PASSWORD=senhaSegura123 ADMIN_NAME="Seu Nome" node scripts/create-first-admin.js
```

Ou com argumentos:

```bash
node scripts/create-first-admin.js seu@email.com senhaSegura123 "Seu Nome"
```

### Validações

1. [ ] Login por e-mail/senha no painel
2. [ ] Acesso restrito a usuários em StaffUser e ativos
3. [ ] Roles (admin, manager, attendant) funcionando
4. [ ] Tenant isolado para manager/attendant
5. [ ] API key usada apenas para integrações técnicas (não no login humano)
6. [ ] Painel não exibe opção de chave quando staff auth ativo

### Testes recomendados

| Cenário | Resultado esperado |
|---------|--------------------|
| Login com e-mail/senha válidos + StaffUser ativo | Acesso ao painel |
| Login com credenciais válidas mas usuário inativo | Mensagem "Usuário inativo" |
| Login com e-mail não autorizado | Mensagem "Usuário não autorizado" |
| Reset de senha para e-mail não cadastrado | Mensagem genérica (sem enumerar e-mails) |
| Manager acessa dados de outro tenant | 403 Forbidden |
| API key em integração técnica | Funciona (se ALLOW_API_KEY_FALLBACK) |

### Riscos e mitigações

| Risco | Mitigação |
|-------|-----------|
| Perda de acesso ao painel | Criar primeiro admin antes de desativar API key fallback |
| Sessão expirada | Mensagem clara, redirecionamento para login |
| Supabase indisponível | Manter ALLOW_API_KEY_FALLBACK=true temporariamente se necessário |

## Rollback

Se precisar voltar ao login por chave:

1. Definir `USE_STAFF_AUTH=false` ou remover `SUPABASE_URL`
2. O painel exibirá o modo legado (Google + chave)
3. `ALLOW_API_KEY_FALLBACK=true` permite API key como fallback

As tabelas StaffUser e AuditLog permanecem; não é necessário reverter migrations.
