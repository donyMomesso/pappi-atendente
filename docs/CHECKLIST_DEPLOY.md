# Checklist Deploy

## Antes do deploy

1. Backup do banco
2. Testar em staging
3. Revisar mudanças (migrations, env)

## Durante o deploy

1. `git pull`
2. `npm install`
3. `npx prisma generate`
4. `npx prisma migrate deploy` (se houver migrations)
5. Reiniciar processo(s)
6. Verificar `/health` e `/ready`

## Após o deploy

1. Verificar logs
2. Testar fluxo crítico
3. Confirmar Baileys conectado (se aplicável)

## Rollback

Ver `docs/CHECKLIST_ROLLBACK.md`.
