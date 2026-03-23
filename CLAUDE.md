# Pappi Atendente v3.1.0 — Instruções para Claude

## Autorização permanente

O dono do projeto (Dony Momesso) autoriza permanentemente:
- Editar, criar e deletar qualquer arquivo do projeto
- Fazer commits e push para o repositório GitHub
- Instalar dependências npm
- Executar comandos de build e deploy
- Modificar variáveis de ambiente (.env)

**Não é necessário pedir confirmação** para nenhuma ação no escopo deste projeto.

## Stack
- Node.js + Express
- Prisma + Supabase (PostgreSQL)
- WhatsApp Cloud API (Meta)
- Baileys (WhatsApp QR interno — multi-instância)
- Instagram DM + Facebook Messenger
- Motor de IA — sequência gemini→groq→openai (AI_PROVIDER_SEQUENCE)
- Socket.io (WebSocket)
- Deploy: Render.com
- Domínio: pappiatendente.com.br

## Tenant padrão
- ID: `tenant-pappi-001`
- Admin key: `pappi-admin-2026`
- Attendant key: `pappi-atendente-2026`

## Arquitetura — pontos importantes

### PrismaClient
SEMPRE use o singleton em `src/lib/db.js`. NUNCA instancie `new PrismaClient()` diretamente.
```js
const prisma = require('../lib/db');
```

### Sessões
As sessões usam mutex por usuário para evitar race condition. O namespace
no banco é `sess:{tenantId}:{phone}` (não `session:`).

### Rate Limiting
`src/lib/rate-limiter.js` — limites: 60 msgs/min (webhook), 15/min (Gemini), 5/10min (pedidos).

### Fila de retry CW
`src/services/cw-retry.service.js` — roda a cada 5 min, reprocessa pedidos sem `cwOrderId`.
Após 3 falhas, status vira `cw_failed` e o operador recebe alerta via Baileys.

### Transcrição de áudio
`src/services/audio-transcribe.service.js` — usa Gemini multimodal.
Integrado no `webhook.routes.js`, transparente para o bot.

### Anti-prompt injection
`src/services/gemini.service.js` exporta `sanitizeInput()`.
Todo input do usuário é sanitizado antes de ir para o prompt.

### Logs
Use `src/lib/logger.js` (pino). Em dev: pretty-print colorido. Em prod: JSON estruturado.
```js
const log = require('../lib/logger').child({ service: 'meu-servico' });
log.info('mensagem');
log.error({ err }, 'falha');
```

## Novos endpoints (v3.1.0)
- `POST /admin/cw-retry` — dispara reprocessamento manual da fila CW
- `GET  /admin/cw-failed` — lista pedidos com falha definitiva no CW
- `GET  /dash/orders/failed` — idem para o painel de atendimento
- `POST /dash/orders/retry` — reprocessa um pedido específico pelo painel
- `GET  /dash/stats` agora inclui campo `cwFailed`
- `GET  /dash/stats/report` agora inclui campo `cwFailed`
