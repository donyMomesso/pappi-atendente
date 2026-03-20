# Pappi Atendente v3.1.0

Sistema de atendimento WhatsApp multi-tenant com IA (Gemini), integração CardápioWeb e painel de operador em tempo real.

## Funcionalidades

- **Chatbot IA** — Atendimento automatizado via Gemini 2.5 Flash
- **Multi-canal** — WhatsApp Cloud API, WhatsApp QR (Baileys), Instagram DM, Facebook Messenger
- **Multi-tenant** — Múltiplos restaurantes em uma única instância
- **Pedidos** — Fluxo completo de pedido com integração CardápioWeb
- **Transcrição de áudio** — Áudios do WhatsApp transcritos via Gemini multimodal
- **Cálculo de taxa** — Distância via Google Maps com geocodificação
- **Painel de atendimento** — Dashboard com WebSocket em tempo real
- **Fila de retry** — Reprocessamento automático de pedidos com falha no CardápioWeb
- **Campanhas de retenção** — Reengajamento de clientes inativos
- **Anti-prompt injection** — Sanitização de inputs antes da IA

## Stack

| Componente | Tecnologia |
|---|---|
| Runtime | Node.js >= 18 |
| Framework | Express 4 |
| Banco de dados | PostgreSQL (Supabase) |
| ORM | Prisma 5 |
| IA | Google Gemini |
| WebSocket | Socket.io 4 |
| WhatsApp oficial | Cloud API (Meta) |
| WhatsApp QR | Baileys 7 |
| Logs | Pino |
| Deploy | Render.com |

## Setup rápido

### 1. Pré-requisitos

- Node.js >= 18
- PostgreSQL 14+ (ou Docker)

### 2. Banco de dados

**Opção A — Docker (recomendado):**

```bash
docker compose up -d
```

**Opção B — PostgreSQL local:**

```bash
createdb pappi_dev
psql pappi_dev -c "CREATE SCHEMA IF NOT EXISTS auth;"
```

### 3. Variáveis de ambiente

```bash
cp .env.example .env
# Edite .env com suas credenciais
```

Variáveis obrigatórias:

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | URL do PostgreSQL |
| `ATTENDANT_API_KEY` | Chave do painel de atendimento |
| `ADMIN_API_KEY` | Chave das rotas de admin |
| `WEBHOOK_VERIFY_TOKEN` | Token de verificação do webhook Meta |

### 4. Instalar dependências e configurar banco

```bash
npm install
npx prisma generate
npx prisma db push
```

### 5. (Opcional) Popular com dados de teste

```bash
npm run db:seed
```

### 6. Rodar em desenvolvimento

```bash
npm run dev
```

O servidor inicia na porta `10000` (ou `PORT` do `.env`).

## Scripts disponíveis

| Script | Descrição |
|---|---|
| `npm run dev` | Servidor com hot-reload (`--watch`) |
| `npm start` | Servidor em produção |
| `npm test` | Testes unitários (Jest) |
| `npm run test:watch` | Testes em modo watch |
| `npm run test:coverage` | Testes com cobertura |
| `npm run lint` | Verificação ESLint |
| `npm run lint:fix` | Correção automática ESLint |
| `npm run format` | Formatar código (Prettier) |
| `npm run format:check` | Verificar formatação |
| `npm run db:generate` | Gerar Prisma Client |
| `npm run db:push` | Sincronizar schema com banco |
| `npm run db:migrate` | Aplicar migrations |
| `npm run db:studio` | Abrir Prisma Studio |
| `npm run db:seed` | Popular banco com dados de teste |

## Arquitetura

```
index.js                  # Entrypoint — cria HTTP server + Socket.io
src/
├── app.js                # Express app — rotas, middleware, schedulers
├── config/
│   └── env.js            # Variáveis de ambiente centralizadas
├── lib/
│   ├── db.js             # Singleton PrismaClient
│   ├── logger.js         # Pino logger
│   ├── rate-limiter.js   # Rate limiting em memória (sliding window)
│   ├── retry.js          # Utility de retry com backoff
│   ├── validate-env.js   # Validação de env vars na inicialização
│   └── whatsapp.js       # Cliente WhatsApp Cloud API
├── middleware/
│   ├── auth.middleware.js    # Autenticação admin/atendente
│   └── tenant.middleware.js  # Resolução de tenant por telefone
├── normalizers/
│   ├── AddressNormalizer.js  # Normalização de endereços
│   └── PhoneNormalizer.js    # Normalização de telefones BR
├── calculators/
│   └── OrderCalculator.js    # Cálculo e validação de totais
├── mappers/
│   └── PaymentMapper.js      # Mapeamento de formas de pagamento
├── services/
│   ├── gemini.service.js         # IA — classificação, extração, chat
│   ├── cardapio.service.js       # Integração CardápioWeb
│   ├── order.service.js          # CRUD de pedidos
│   ├── customer.service.js       # CRUD de clientes
│   ├── session.service.js        # Sessões conversacionais (mutex)
│   ├── chat-memory.service.js    # Histórico de mensagens
│   ├── tenant.service.js         # Cache e CRUD de tenants
│   ├── baileys.service.js        # WhatsApp via QR (multi-instância)
│   ├── socket.service.js         # WebSocket (Socket.io)
│   ├── maps.service.js           # Google Maps geocoding
│   ├── retention.service.js      # Campanhas de retenção
│   ├── cw-retry.service.js       # Fila de retry CardápioWeb
│   ├── audio-transcribe.service.js  # Transcrição de áudio
│   ├── meta-social.service.js    # Instagram DM / Facebook Messenger
│   └── meta-capi.service.js      # Meta Conversions API
├── routes/
│   ├── webhook.routes.js     # POST /webhook (Meta)
│   ├── bot.handler.js        # Lógica do chatbot
│   ├── admin.routes.js       # /admin/* (CRUD tenants)
│   ├── dashboard.routes.js   # /dash/* (painel atendente)
│   ├── orders.routes.js      # /orders/* (pedidos)
│   ├── internal.routes.js    # /internal/* (Baileys, retention)
│   └── diag.routes.js        # /diag/* (diagnóstico)
└── public/                   # Dashboard HTML estático
```

## Endpoints principais

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| GET | `/health` | — | Health check |
| GET/POST | `/webhook` | Meta | Webhook WhatsApp |
| GET | `/admin/tenants` | Admin | Listar tenants |
| POST | `/admin/tenants` | Admin | Criar tenant |
| PATCH | `/admin/tenants/:id` | Admin | Atualizar tenant |
| POST | `/admin/cw-retry` | Admin | Forçar retry de pedidos CW |
| GET | `/admin/cw-failed` | Admin | Listar pedidos com falha CW |
| GET | `/dash/stats` | Atendente | Estatísticas do painel |
| GET | `/dash/orders/failed` | Atendente | Pedidos com falha |
| POST | `/dash/orders/retry` | Atendente | Retry de pedido específico |

**Headers de autenticação:** `x-api-key` ou `Authorization: Bearer <key>`

## Licença

Proprietário — Dony Momesso
