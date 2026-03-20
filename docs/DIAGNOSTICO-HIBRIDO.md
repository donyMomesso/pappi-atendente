# Diagnóstico: Integração Atendimento Híbrido (Humano + Robô)

## 1. Arquitetura Atual

### WhatsApp
- **Cloud API**: `src/lib/whatsapp.js` — cliente HTTP para Meta Graph API v19.0
- **Webhook**: `src/routes/webhook.routes.js` — GET verificação, POST eventos
- **Multi-tenant**: `waToken`, `waPhoneNumberId` por tenant em `tenants`
- **Baileys**: `src/services/baileys.service.js` — WhatsApp interno (notificações, NÃO para atendimento híbrido)

### Fluxo de Mensagens
- Webhook recebe → `processMessage` → `findOrCreate` customer → `chatMemory.push` (customer) → se `handoff` retorna (bot não responde) → senão `bot.handler.handle`
- Mensagens do bot: `chatMemory.push(customerId, "bot"|"assistant", ...)`
- Mensagens do painel: `POST /dash/send` → `chatMemory.push(..., "attendant", ..., sender)`

### Handoff Existente
- **Customer**: `handoff`, `handoffAt`, `queuedAt`, `claimedBy`
- **customer.service**: `setHandoff`, `claimFromQueue`, `releaseHandoff`
- **Webhook**: se `customer.handoff` → retorna sem chamar bot
- **Dashboard**: `/queue`, `/queue/claim`, `/queue/release`, `/handoff` (toggle)
- **Painel**: fila, "Assumir", "Encerrar" (release), toggle Bot ON/OFF

### Estados Implícitos (derivados de handoff/claimedBy)
- `handoff=false` → bot ativo
- `handoff=true`, `claimedBy=null` → aguardando humano
- `handoff=true`, `claimedBy` set → humano ativo
- **Falta**: estado "encerrado" (conversa fechada até nova mensagem)

### Chat Memory / Message
- **role**: `customer`, `assistant`, `attendant`
- **sender**: nome do atendente (para attendant)
- Já suporta origem da mensagem

### Config / Env
- `WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_TOKEN` (ou por tenant: `waToken`), `waPhoneNumberId`
- Tenant usa `waToken`, `waPhoneNumberId` do banco

---

## 2. O Que Pode Ser Reaproveitado

| Componente          | Uso                                                |
|---------------------|----------------------------------------------------|
| Customer.handoff    | Base para estados aguardando_humano / humano_ativo |
| claimFromQueue      | "Assumir atendimento" → humano_ativo               |
| releaseHandoff      | "Devolver ao robô" → bot_ativo                     |
| Webhook processMessage | Ponto de decisão: handoff → não chama bot     |
| chatMemory.push     | Registrar customer, bot, attendant                 |
| Dashboard /queue    | Fila e ações existentes                            |
| socket.queue_update | Atualização em tempo real                          |

---

## 3. Plano de Integração (Mínimo de Impacto)

### 3.1 Estado da Conversa
- **Onde**: Config table, key `conv:${customerId}`, value `{state, updatedAt}`
- **Estados**: `bot_ativo` | `aguardando_humano` | `humano_ativo` | `encerrado`
- **Derivação**: se Config ausente, derivar de handoff/claimedBy (backward compat)

### 3.2 Serviço conversation-state.service.js (novo)
- `getState(customerId)` — lê Config ou deriva
- `setState(customerId, state)` — persiste
- `shouldBotRespond(customerId)` — false se humano_ativo ou aguardando_humano
- `resetOnNewMessage(customerId)` — se encerrado, volta a bot_ativo

### 3.3 Alterações no Webhook
- Antes de chamar bot: checar `shouldBotRespond` (além de handoff)
- Ao receber msg de customer com state=encerrado: `resetOnNewMessage` → bot_ativo
- Tratar **message echo** (Meta): se msg enviada pelo negócio (Business App), registrar como human e não processar bot

### 3.4 Alterações no customer.service
- `setHandoff(true)` → setState aguardando_humano
- `claimFromQueue` → setState humano_ativo
- `releaseHandoff` → setState bot_ativo
- Novo: `closeConversation(customerId)` → setState encerrado, clear handoff

### 3.5 Dashboard
- Novo endpoint: `POST /dash/queue/close` — encerrar (não devolver ao bot)
- Ajustar UI: distinguir "Encerrar" vs "Devolver ao robô"
- Exibir estado atual na conversa

### 3.6 Handoff Triggers (expandir)
- Adicionar: reclamação, cancelamento, cobrança, motoboy, erro no pedido, etc.

### 3.7 Message Echo (Business App)
- No webhook: se `msg.context?.from === metadata.phone_number_id` ou flag similar, tratar como echo
- Registrar em chatMemory com role=human, sender="App"

### 3.8 Timeout (opcional)
- Scheduler: clientes em humano_ativo com lastInteraction > X min → setState bot_ativo
- Configurável via `CONVERSATION_HANDOFF_TIMEOUT_MIN`

---

## 4. Arquivos a Alterar

| Arquivo                        | Alteração                                      |
|--------------------------------|------------------------------------------------|
| src/services/conversation-state.service.js | NOVO — estado e regras                    |
| src/services/customer.service.js           | Integrar setState em setHandoff, claim, release; add closeConversation |
| src/routes/webhook.routes.js   | Checar shouldBotRespond; echo; reset encerrado  |
| src/routes/dashboard.routes.js | POST /queue/close; incluir state em queue/conversations |
| src/routes/bot.handler.js      | setHandoff já chama customer.service — ok      |
| public/index.html              | Botão "Encerrar" vs "Devolver ao robô"; badge de estado |
| src/config/env.js              | CONVERSATION_HANDOFF_TIMEOUT_MIN (opcional)    |
| src/app.js                     | Scheduler de timeout (opcional)                |

---

## 5. Sem Migrations
- Usar Config para `conv:{customerId}` — sem alterar schema.
