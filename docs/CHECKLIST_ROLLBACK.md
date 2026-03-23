# Checklist Rollback

## Rollback de código

1. `git revert` ou `git checkout <commit-anterior>`
2. `npm install`
3. Reiniciar processo(s)
4. Verificar `/health`

## Rollback de migration

1. Identificar migration problemática
2. Criar migration de reversão (ou restaurar backup)
3. `npx prisma migrate resolve --rolled-back <migration_name>` se necessário
4. Restaurar backup do banco se dados foram corrompidos

## Rollback de variáveis

1. Reverter alterações no `.env` ou painel
2. Reiniciar processo(s)

## Contatos de emergência

Definir responsáveis e canais de comunicação.
