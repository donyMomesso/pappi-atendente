# Plano: Atendimento Híbrido WhatsApp (Cloud API)

## Estado atual

O suporte híbrido **já está implementado**. Este documento consolida o que existe e as alterações incrementais aplicadas.

### Componentes existentes (reaproveitados)

| Componente | Uso |
|------------|-----|
| `Customer.handoff`, `claimedBy`, `queuedAt` | Base para estados |
| `customer.service` | setHandoff, claimFromQueue, releaseHandoff |
| `webhook.routes.js` | processMessage, extractContent, handoff trigger |
| `chatMemory` | Histórico com role (customer, bot, attendant, human) |
| `session.service` | Sessão do fluxo (mutex, Config) |
| Dashboard | /queue, /handoff, claim, release |

### Componentes criados para híbrido

| Arquivo | Função |
|---------|--------|
| `conversation-state.service.js` | Estados: bot_ativo, aguardando_humano, humano_ativo, encerrado |
| `handoff-timeout-scheduler.js` | Devolve ao robô após X min inatividade (opcional) |
| `POST /dash/queue/close` | Encerrar conversa (não devolver ao bot) |

### Webhook Meta (já implementado)

- GET /webhook — verificação (hub.mode, hub.verify_token)
- POST /webhook — eventos whatsapp_business_account
- Processa: messages, statuses
- Suporte a echo (mensagens enviadas pelo Business App)
- Rate limiting, transcrição de áudio

---

## Alterações incrementais desta sessão

1. **processSocialMessage**: Adicionar `resetIfEncerrado` antes da checagem de handoff (consistência com webhook WhatsApp).
2. **closeConversation**: Limpar sessão para fresh start na próxima mensagem.
3. **Baileys**: Usar `convState.shouldBotRespond` em vez de só `handoff` (consistência).

---

## Arquivos alterados

- `src/services/customer.service.js` — closeConversation limpa sessão
- `src/routes/webhook.routes.js` — processSocialMessage usa resetIfEncerrado
- `src/services/baileys.service.js` — usa convState.shouldBotRespond

---

## Migrations

**Nenhuma.** Estado usa tabela `Config` (key: `conv:{customerId}`).

---

## Diffs (alterações desta sessão)

### customer.service.js — closeConversation
```diff
 /** Encerra a conversa (não devolve ao robô até nova mensagem do cliente). Limpa sessão para fresh start. */
 async function closeConversation(customerId) {
   ...
   await convState.setState(customerId, convState.STATES.ENCERRADO);
+  const sessionService = require("./session.service");
+  await sessionService.clear(customer.tenantId, customer.phone);
   return customer;
 }
```

### webhook.routes.js — processSocialMessage
```diff
     await chatMemory.push(customer.id, "customer", text.trim(), null, null, "text");

-    if (customer.handoff) return;
+    await convState.resetIfEncerrado(customer);
+    const botMayRespond = await convState.shouldBotRespond(customer);
+    if (!botMayRespond) return;

     if (isHandoffTrigger(text)) {
```

### baileys.service.js — roteamento do bot
```diff
                 const customer = await findOrCreate(tenantId, phone, null);
                 await touchInteraction(customer.id);
-                if (!customer.handoff) {
+                const convState = require("./conversation-state.service");
+                const botMayRespond = await convState.shouldBotRespond(customer);
+                if (!botMayRespond) continue;
                  const wa = {
```

---

## Passos de teste

1. **Fluxo bot → humano → bot**
   - Cliente: "quero falar com atendente" → bot coloca em fila
   - Painel: Assumir → humano_ativo
   - Cliente envia msg → bot não responde
   - Painel: Devolver ao robô → bot_ativo
   - Cliente envia msg → bot responde

2. **Encerrar**
   - Humano ativo → Encerrar
   - Cliente envia msg → bot responde (fresh start, sessão limpa)

3. **Timeout** (se CONVERSATION_HANDOFF_TIMEOUT_MIN > 0)
   - Assumir → inatividade X min → devolve ao robô automaticamente
