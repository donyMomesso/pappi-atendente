# Resumo Técnico: Integração Atendimento Híbrido

## O que foi reaproveitado

| Componente | Uso |
|------------|-----|
| `Customer.handoff`, `claimedBy`, `queuedAt` | Base para estados da conversa |
| `customer.service`: setHandoff, claimFromQueue, releaseHandoff | Integrados com conversation-state |
| `webhook.routes.js` processMessage | Ponto de decisão: shouldBotRespond, echo, reset encerrado |
| `chatMemory.push` | Registra customer, bot, attendant, human |
| `dashboard.routes.js` /queue, /handoff | Rotas existentes ajustadas |
| `socket.queue_update` | Atualização em tempo real |
| Painel `index.html` | handoffBar, claim, release — adicionados close e "Devolver ao robô" |

## O que foi criado

| Arquivo | Descrição |
|---------|-----------|
| `src/services/conversation-state.service.js` | Estados (bot_ativo, aguardando_humano, humano_ativo, encerrado), getState, setState, shouldBotRespond, resetIfEncerrado |
| `src/services/handoff-timeout-scheduler.js` | Devolve ao robô após X min de inatividade (opcional) |
| `docs/DIAGNOSTICO-HIBRIDO.md` | Diagnóstico e plano |
| `docs/RESUMO-HIBRIDO.md` | Este resumo |

## O que foi alterado

| Arquivo | Alteração |
|---------|-----------|
| `src/services/customer.service.js` | setHandoff, claimFromQueue, releaseHandoff chamam convState.setState; novo closeConversation |
| `src/routes/webhook.routes.js` | isMessageEcho, extractEchoContent; convState.shouldBotRespond; convState.resetIfEncerrado; HANDOFF_WORDS expandido |
| `src/routes/dashboard.routes.js` | Usa customer.service; POST /queue/close; handoff aceita phone; conversations/queue incluem conversationState |
| `src/config/env.js` | CONVERSATION_HANDOFF_TIMEOUT_MIN |
| `src/app.js` | handoff-timeout-scheduler |
| `public/index.html` | handoffBar: "Devolver ao robô" e "Encerrar"; closeCustomer(); role human tratado no chat |
| `.env.example` | CONVERSATION_HANDOFF_TIMEOUT_MIN |

## Migrations

**Nenhuma.** O estado da conversa usa a tabela `Config` (key `conv:{customerId}`).

## Configuração externa

### Meta / WhatsApp Cloud API

1. **App em developers.facebook.com**
   - Produto WhatsApp > API Setup
   - Token de acesso permanente
   - phone_number_id do número de teste ou produção

2. **Webhook**
   - URL: `https://seu-dominio.com/webhook`
   - Verify Token: igual a `WEBHOOK_VERIFY_TOKEN` do `.env`
   - Subscrever: `messages` (obrigatório)

3. **Variáveis (multi-tenant)**
   - Por tenant na tabela `tenants`: `waToken`, `waPhoneNumberId`
   - Ou fallback no `.env`: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`

4. **Coexistência Business App + Cloud API**
   - Mesmo número pode usar App e API
   - Mensagens enviadas pelo App podem ser ecoadas no webhook (campo `from` = phone_number_id)
   - O código trata echo e grava como role `human`

### Variáveis de ambiente

```
WEBHOOK_VERIFY_TOKEN=...     # Verificação do webhook
WHATSAPP_TOKEN=...           # Ou por tenant no banco
WHATSAPP_PHONE_NUMBER_ID=... # Ou por tenant no banco
CONVERSATION_HANDOFF_TIMEOUT_MIN=15  # Opcional: devolve ao robô após 15 min (0 = desativado)
```

## Como testar

### 1. Fluxo bot → humano → robô

1. Cliente envia "oi" → bot responde
2. Cliente envia "quero falar com atendente" → bot coloca em handoff e avisa
3. Painel: fila mostra o cliente; clicar "Assumir"
4. Enviar mensagem pelo painel (ou pelo WhatsApp Business App)
5. Cliente responde → bot não responde
6. "Devolver ao robô" → cliente volta a ser atendido pelo bot
7. Cliente envia nova mensagem → bot responde

### 2. Encerrar

1. Com atendimento humano ativo, clicar "Encerrar"
2. Conversa é fechada (estado encerrado)
3. Próxima mensagem do cliente reinicia o fluxo com o bot

### 3. Timeout (se configurado)

1. `CONVERSATION_HANDOFF_TIMEOUT_MIN=5`
2. Assumir atendimento e não enviar mensagens por 5 min
3. Sistema devolve ao robô automaticamente

## Riscos e lacunas

- **Echo do Business App**: A lógica assume `msg.from === phoneNumberId`. Se a Meta enviar outro formato, pode precisar de ajuste. O endpoint `/webhook-log` (admin) ajuda a inspecionar o payload.
- **Baileys**: O Baileys é para notificações internas, não para o fluxo híbrido principal. O atendimento híbrido usa Cloud API.
- **Handoff por Gemini**: Não há detecção de “falha de entendimento” via IA. Os gatilhos são apenas palavras-chave (HANDOFF_WORDS). É possível depois integrar classificação com Gemini.

## Pontos de extensão

- Endpoint `GET /dash/customer/:id/state` para exibir o estado no painel
- Dashboard com filtro por estado (bot_ativo, humano_ativo etc.)
- Métricas de tempo médio em cada estado
