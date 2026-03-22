# Monitoramento de Atraso de Pedidos (CardápioWeb)

## Visão geral

Sistema que monitora pedidos parados em `em_producao` e:
- Recalcula previsão com média do dia
- Envia mensagens humanizadas ao cliente
- Cria alertas para o atendente
- Considera clima (chuva) como fator de atraso
- Permite compensação com cupom (borda grátis)

## Fluxo do pedido no CardápioWeb

1. `em_producao` / `in_production`
2. `saiu_para_entrega` / `pronto_para_retirada` / `dispatched`
3. `pedido_concluido` / `delivered`

## Regras

- **60 min** em produção sem avançar → inicia fluxo de atraso
  - 1º alerta ao cliente + alerta interno
- **+15 min** (configurável) → 2º alerta
- **+15 min** → 3º alerta
- **90+ min** → prioridade máxima + escalar para humano + notificar via Baileys

## Configuração

### Webhook CardápioWeb

Configure o CardápioWeb para enviar alterações de status para:

```
POST https://<seu-dominio>/orders/cw-status
Content-Type: application/json
Body: { "order_id": "<cwOrderId>", "status": "em_producao" }
```

O tenant é inferido pelo `order_id` (cwOrderId único no banco).

### Parâmetros (opcional)

- `{tenantId}:delay_alert_interval_min` — intervalo entre alertas (15 ou 20). Padrão: 15.

```bash
# Definir 20 min entre alertas
node -e "
const prisma = require('./src/lib/db');
prisma.config.upsert({
  where: { key: 'tenant-pappi-001:delay_alert_interval_min' },
  create: { key: 'tenant-pappi-001:delay_alert_interval_min', value: '20' },
  update: { value: '20' }
}).then(() => prisma.\$disconnect());
"
```

## Migração do banco

Execute o SQL para adicionar os campos no `orders`:

```bash
# Com psql
psql "$DATABASE_URL" -f prisma/migrations/20250320000000_add_order_delay_fields/migration.sql

# Ou via npx prisma db push (se o schema estiver alinhado)
npx prisma db push
```

## Arquivos

| Arquivo | Descrição |
|---------|-----------|
| `src/services/order-delay.service.js` | Cálculo de médias do dia e previsão |
| `src/services/order-delay-monitor.service.js` | Job de monitoramento (5 min) |
| `src/services/weather.service.js` | Clima (Open-Meteo) para fator chuva |
| `src/services/coupon.service.js` | Geração de cupons de compensação |
| `src/routes/orders.routes.js` | Webhook `/orders/cw-status` |
| `src/routes/dashboard.routes.js` | `/delay-alerts`, `/orders/:id/watch`, `/orders/:id/compensate` |

## Painel

- **Atrasos** (sidebar) — lista pedidos em monitoramento
- **Acompanhar** — abre o chat do cliente
- **Assumir** — marca atendente responsável
- **Compensar** — gera cupom borda grátis e envia ao cliente

## Mensagens ao cliente

1º: *"Oi, [NOME]. Não quis te deixar sem atualização. Seu pedido ainda está em produção..."*  
2º: *"[NOME], passando para te atualizar novamente: seu pedido ainda está em produção..."*  
3º: *"[NOME], sigo acompanhando seu pedido e já sinalizei a produção..."*

Com chuva: previsão atualizada + contexto de clima.

Compensação: *"[NOME], olha o que eu consegui para você: uma borda grátis no seu próximo pedido. Use o cupom [CUPOM]..."*
