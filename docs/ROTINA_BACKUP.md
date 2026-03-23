# Rotina de Backup

## Banco de dados

### Frequência recomendada

- **Diário** para produção
- **Antes de migrations** sempre

### Comando (Postgres)

```bash
pg_dump -h HOST -U USER -d DBNAME -F c -f backup_$(date +%Y%m%d).dump
```

### Supabase

- Usar backup automático do plano
- Ou export manual via dashboard

### Retenção

- Manter últimos 7 dias
- Manter backup pré-migration por 30 dias

## Dados críticos

- Tabela `tenants`
- Tabela `customers`
- Tabela `orders`
- Config `baileys:auth:{env}:*` (sessões WhatsApp, ex: baileys:auth:prod:default)

## Teste de restore

- Executar restore em ambiente de staging periodicamente
- Validar integridade dos dados
