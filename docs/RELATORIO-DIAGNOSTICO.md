# Relatório de Diagnóstico — Pappi Atendente v3.1.0

## 1. Arquitetura Atual

### 1.1 Visão Geral

Monólito Node.js/Express, single-process, com:

- **API HTTP** (Express) — rotas, webhooks, painel
- **WebSocket** (Socket.io) — tempo real no painel
- **Agendadores** — retention, cw-retry, avise-abertura, handoff-timeout
- **Multi-tenant** — tenant por `waPhoneNumberId`, dados isolados por `tenantId`

### 1.2 Fluxo de Dados

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                    PONTOS DE ENTRADA                     │
                    └─────────────────────────────────────────────────────────┘
                                         │
     ┌──────────────────┬────────────────┼────────────────┬──────────────────┐
     │                  │                │                │                  │
     ▼                  ▼                ▼                ▼                  ▼
┌─────────┐      ┌──────────┐    ┌───────────┐    ┌──────────┐       ┌──────────┐
│ Webhook │      │ Baileys  │    │ Internal  │    │ Dashboard│       │ Orders   │
│  Meta   │      │ (QR/App) │    │  /send    │    │  /send   │       │ /handoff │
└────┬────┘      └────┬─────┘    └─────┬─────┘    └────┬─────┘       └────┬─────┘
     │                │                │                │                  │
     │                │                │                │                  │
     ▼                ▼                ▼                ▼                  ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│                         webhook.routes.js / processMessage                       │
│  • findOrCreate customer  • chatMemory.push  • convState  • handoff trigger     │
└────────────────────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   bot.handler   │     │ customer.service│     │ session.service │
│   (fluxo pedido)│     │ (handoff, etc)  │     │ (sessão passo)  │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│  • Gemini (IA)  • CardápioWeb  • Maps  • chatMemory  • Prisma (Message, Order)  │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Stack Usada

| Camada | Tecnologia |
|--------|------------|
| Runtime | Node.js >= 18 |
| Framework | Express 4.18 |
| Banco | PostgreSQL (Prisma ORM) |
| WhatsApp | Cloud API (Meta Graph v19.0), Baileys (QR interno) |
| IA | @google/generative-ai (Gemini 2.0/2.5 flash) |
| Tempo real | Socket.io |
| Integração | CardápioWeb (REST), Google Maps API, ViaCEP |
| Deploy | Render.com |

---

## 3. Arquivos Relacionados a WhatsApp / Chatbot / Atendimento

### 3.1 WhatsApp — envio e recebimento

| Arquivo | Função |
|---------|--------|
| `src/lib/whatsapp.js` | Cliente HTTP para Meta Cloud API (sendText, sendButtons, sendTemplate, markRead, getMediaUrl) |
| `src/routes/webhook.routes.js` | Webhook Meta: GET verificação, POST eventos (messages, statuses); processMessage, extractContent |
| `src/services/baileys.service.js` | WhatsApp via Baileys (QR); recebe msgs, roteia para bot; notificações internas |
| `src/services/tenant.service.js` | getClients(tenantId) → { cw, wa }; createWaClient por tenant |

### 3.2 Chatbot / fluxo do bot

| Arquivo | Função |
|---------|--------|
| `src/routes/bot.handler.js` | handle(), _handle() — fluxo de pedido (greeting, fulfillment, address, ordering, payment, confirm) |
| `src/services/gemini.service.js` | classifyIntent, extractAddress, chatOrder (IA) |
| `src/services/session.service.js` | Sessão por tenant+phone (Config: sess:…), mutex, TTL 30min |
| `src/services/time-routing.service.js` | Slots por horário (Manhã, Tarde, Pré-Abertura, Aberto, Pós) |

### 3.3 Atendimento humano / handoff

| Arquivo | Função |
|---------|--------|
| `src/services/customer.service.js` | setHandoff, claimFromQueue, releaseHandoff, closeConversation |
| `src/services/conversation-state.service.js` | Estados: bot_ativo, aguardando_humano, humano_ativo, encerrado (Config: conv:…) |
| `src/services/handoff-timeout-scheduler.js` | Devolve ao robô após X min de inatividade |
| `src/routes/dashboard.routes.js` | /queue, /queue/claim, /queue/release, /queue/close, /handoff, /send |
| `src/routes/orders.routes.js` | PUT /orders/handoff (API attendant) |

### 3.4 Histórico / mensagens

| Arquivo | Função |
|---------|--------|
| `src/services/chat-memory.service.js` | push(), get(), updateStatus(); cache + Message (Prisma) |
| `prisma/schema.prisma` | Message (role, text, sender, mediaUrl, waMessageId, status) |

### 3.5 Outros (horário, aviso, retenção)

| Arquivo | Função |
|---------|--------|
| `src/services/avise-abertura.service.js` | Lista "Me avise quando abrir", notificarClientesAbertura |
| `src/services/avise-abertura-scheduler.js` | Disparo às 18h |
| `src/services/retention.service.js` | Campanhas de reengajamento |

---

## 4. Pontos de Entrada de Mensagens

| Origem | Rota / evento | Destino | Observação |
|--------|----------------|---------|------------|
| **Meta Webhook** | POST /webhook (body.object = whatsapp_business_account) | processMessage → bot.handler | Fluxo principal Cloud API |
| **Baileys** | sock.ev.on("messages.upsert") | bot.handler.handle | Número diferente do Cloud API; botEnabled |
| **Internal API** | POST /internal/send | wa.sendText + chatMemory.push(attendant) | Envio por API (attendant key) |
| **Dashboard** | POST /dash/send | wa.sendText + chatMemory.push(attendant) | Envio pelo painel |
| **Instagram/Facebook** | POST /webhook (object=instagram/page) | processSocialMessage | Gemini chatOrder, não bot.handler |

### Decisão “bot responde?”

- **Webhook**: `convState.shouldBotRespond(customer)` — considera bot_ativo, aguardando_humano, humano_ativo, encerrado
- **Baileys**: apenas `!customer.handoff` — não usa conversation-state (gap)

---

## 5. Riscos de Integração

### 5.1 Conflito humano + robô

- **Mitigação atual**: convState.shouldBotRespond no webhook; handoff no Customer
- **Risco**: Baileys só usa handoff; se Baileys for usado como canal principal, estado “encerrado” não é considerado

### 5.2 Duplicação de mensagens

- **Mitigação**: sessionService.withLock por tenant:phone no bot.handler
- **Risco**: Webhooks duplicados da Meta podem gerar processamento em paralelo antes do lock

### 5.3 Message echo (Business App)

- **Atual**: isMessageEcho() verifica msg.from === phoneNumberId; pode não bater com formato real da Meta
- **Risco**: Estrutura de echo pode variar; necessário validar com payload real

### 5.4 Sessão vs estado da conversa

- **Sessão**: passo do fluxo (MENU, FULFILLMENT, ADDRESS, …) em Config
- **Estado**: bot_ativo, humano_ativo, etc. em Config
- **Risco**: Se liberar para o bot sem limpar sessão, pode continuar em passo avançado (ex.: ADDRESS)

### 5.5 Múltiplos handoffs

- **orders.routes**: PUT /orders/handoff (phone, enabled)
- **dashboard.routes**: PUT /dash/handoff (customerId/phone, enabled)
- **Risco**: Comportamento deve ser o mesmo (setHandoff), mas parâmetros diferentes (phone vs customerId)

### 5.6 Rate limiting

- **webhook**: checkWebhook(phone) — 30 msg/min
- **Risco**: Clientes legítimos muito ativos podem ser bloqueados

---

## 6. Proposta de Implementação com Mínimo Impacto

### 6.1 Princípios

1. **Sem migrations** — usar Config para novos estados/metadados quando possível  
2. **Preservar contrato** — manter assinaturas de funções e formatos de resposta  
3. **Mudanças incrementais** — um conceito por vez, com testes entre etapas  
4. **Reaproveitar** — customer.service, convState, chatMemory, session

### 6.2 Para novas funcionalidades (ex.: integração híbrida refinada)

| Etapa | Ação | Arquivos | Impacto |
|-------|------|----------|---------|
| 1 | Alinhar Baileys ao conversation-state | baileys.service.js | Baileys usa shouldBotRespond quando disponível |
| 2 | Validar echo no webhook | webhook.routes.js | Log e fallback se estrutura mudar |
| 3 | Garantir que release/close limpem sessão | customer.service ou bot.handler | Evitar sessão “presa” em passo antigo |
| 4 | Adicionar testes de regressão | tests/ | Cobrir handoff, convState, envio |

### 6.3 Para correções pontuais

- **Bug em fluxo**: alterar apenas bot.handler ou handler específico  
- **Novo gatilho de handoff**: adicionar termo em HANDOFF_WORDS (webhook.routes.js)  
- **Novo canal**: novo branch em processMessage ou rota dedicada, reutilizando findOrCreate + chatMemory + convState

### 6.4 Checklist antes de alterar

- [ ] Identificar todos os pontos que leem/escrevem o dado afetado  
- [ ] Verificar se há testes que cobrem o fluxo  
- [ ] Garantir backward compatibility (ex.: handoff legado sem convState)  
- [ ] Documentar nova variável de ambiente no .env.example  

---

## 7. Estrutura de Pastas (resumo)

```
src/
├── config/env.js
├── lib/
│   ├── db.js, logger.js, rate-limiter.js, retry.js, validate-env.js
│   └── whatsapp.js
├── routes/
│   ├── webhook.routes.js    ← entrada principal mensagens
│   ├── bot.handler.js       ← lógica do chatbot
│   ├── dashboard.routes.js  ← painel + fila + handoff
│   ├── internal.routes.js   ← API send
│   ├── orders.routes.js     ← status pedido + handoff
│   ├── admin.routes.js
│   └── diag.routes.js
├── services/
│   ├── conversation-state.service.js
│   ├── customer.service.js
│   ├── chat-memory.service.js
│   ├── session.service.js
│   ├── tenant.service.js
│   ├── gemini.service.js
│   ├── baileys.service.js
│   ├── time-routing.service.js
│   ├── avise-abertura*.js
│   ├── handoff-timeout-scheduler.js
│   └── ...
└── middleware/, mappers/, normalizers/, calculators/
```

---

*Documento gerado em análise do código. Última atualização: Pappi Atendente v3.1.0.*
