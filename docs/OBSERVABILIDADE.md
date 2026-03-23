# Observabilidade

## Endpoints

| Endpoint | Auth | Uso |
|----------|------|-----|
| `GET /health` | Nenhuma | Load balancer, status básico |
| `GET /ready` | Token opcional | Readiness (DB conectado) |
| `GET /health?token=xxx` | HEALTHCHECK_TOKEN | Healthcheck privado |

## /health

Retorna:
- `ok`: boolean
- `version`: string
- `db`: "ok" | "error"
- `env`: NODE_ENV

## /ready

- Verifica conexão com o banco
- Se `HEALTHCHECK_TOKEN` configurado, requer `?token=xxx`
- 200 = pronto, 503 = não pronto

## Logs

- Pino (JSON em produção, pretty em dev)
- Contexto por serviço: `{ service: "webhook" }`, etc
- Níveis: debug, info, warn, error
- `LOG_LEVEL` controla verbosidade

## Métricas

Não implementado. Estrutura preparada para futura adoção de Prometheus ou similar.
