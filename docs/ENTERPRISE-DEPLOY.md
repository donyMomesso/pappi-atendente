# Pappi Atendente Enterprise

## O que entrou nesta versão
- request id por requisição
- logs HTTP estruturados
- métricas Prometheus em `/metrics`
- idempotência de webhook para mensagens duplicadas
- Redis opcional para escalar locks e idempotência
- base de filas BullMQ pronta para workers separados
- diagnóstico enterprise em `/enterprise/diagnostics`
- duplo check do Cardápio Web antes de criar pedido
- validação de assinatura do webhook da Meta

## Variáveis obrigatórias
- `META_APP_SECRET`
- `WEBHOOK_VERIFY_TOKEN`
- `ADMIN_API_KEY`

## Variáveis recomendadas
- `REDIS_URL`
- `METRICS_TOKEN`
- `RUN_BAILEYS`
- `RUN_JOBS`
- `APP_RUNTIME`

## Rotas novas
- `GET /metrics`
- `GET /enterprise/diagnostics`

## Subida recomendada
### Web
`APP_RUNTIME=web RUN_BAILEYS=false RUN_JOBS=true npm run start:web`

### Baileys
`APP_RUNTIME=baileys RUN_BAILEYS=true RUN_JOBS=false npm run start:baileys`

### Worker enterprise
`REDIS_URL=redis://... npm run start:worker`
