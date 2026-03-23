# Checklist Go-Live

## Pré-produção

- [ ] Banco de produção criado e isolado
- [ ] Variáveis de ambiente configuradas (`.env.production.example` como base)
- [ ] `WEB_CONCURRENCY=1` definido
- [ ] Chaves ADMIN e ATTENDANT fortes e únicas
- [ ] `CORS_ORIGIN` com domínio real (sem `*`)
- [ ] SSL/HTTPS configurado
- [ ] Backup do banco agendado

## Deploy

- [ ] `npm run db:migrate` aplicado no banco de produção
- [ ] Servidor sobe sem erros
- [ ] `/health` retorna 200
- [ ] `/ready` retorna 200 (se usado)

## Baileys

- [ ] QR escaneado e conectado
- [ ] Nenhum outro processo com mesma sessão
- [ ] Logs sem 440

## Pós-go-live

- [ ] Testar fluxo de pedido ponta a ponta
- [ ] Testar painel de atendimento
- [ ] Verificar webhook Meta conectado
