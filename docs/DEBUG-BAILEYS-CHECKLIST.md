# Checklist de debug — Baileys + Painel

Siga em ordem para identificar onde está o problema.

---

## 1. Vincular a instância ao tenant

No **console do navegador** (na mesma origem do painel, ex: https://pappiatendente.com.br):

```javascript
fetch('/dash/baileys/instances/default/tenant?tenant=tenant-pappi-001&key=pappi-admin-2026', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ tenantId: 'tenant-pappi-001' })
}).then(r => r.json()).then(console.log)
```

Depois confirme:

```javascript
fetch('/dash/baileys/instances?tenant=tenant-pappi-001&key=pappi-admin-2026')
  .then(r => r.json())
  .then(console.log)
```

**Esperado:** `instanceTenant: "tenant-pappi-001"` em cada instância.

---

## 2. Testar chegada da mensagem no backend

Envie um WhatsApp para o número conectado e verifique o **log do backend**.

**Esperado:** aparecer algo como `MSG recebida`.

Se **não** aparecer, o evento `messages.upsert` do Baileys não está chegando.

---

## 3. Ver se a conversa foi criada

```javascript
fetch('/dash/conversations?tenant=tenant-pappi-001&key=pappi-admin-2026')
  .then(r => r.json())
  .then(console.log)
```

Procure o telefone que você usou no passo 2.

---

## 4. Pegar o customerId e ver as mensagens

Com o `customerId` da conversa do passo 3:

```javascript
fetch('/dash/messages/COLOQUE_O_CUSTOMER_ID?tenant=tenant-pappi-001&key=pappi-admin-2026')
  .then(r => r.json())
  .then(console.log)
```

Se a mensagem aparecer aqui, o problema está na **UI/realtime**, não no Baileys.

---

## 5. Testar realtime do painel

No **DevTools** da tela do painel (aba Network → WS):

- Veja se existe conexão WebSocket ativa.

Se a mensagem foi salva no passo 4 mas não aparece na tela, o problema provavelmente é:
- `socket.service` no backend, ou
- Frontend não escutando `new_message` / `conv_update`.

---

## 6. Testar envio manual

Com o `customerId` da conversa:

```javascript
fetch('/dash/send?tenant=tenant-pappi-001&key=pappi-admin-2026', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    customerId: 'COLOQUE_O_CUSTOMER_ID',
    phone: '5519SEUNUMERO',
    text: 'teste manual painel'
  })
}).then(r => r.json()).then(console.log)
```

Se enviar, o fluxo **Baileys → cliente** está funcionando.

---

## Leitura do resultado

| Sintoma | Causa provável |
|--------|----------------|
| Não aparece "MSG recebida" no log | Problema na captura do Baileys |
| Aparece no log, mas não entra em `/conversations` | Problema em `detectTenantByPhone` ou `findOrCreate` |
| Entra em `/conversations` e `/messages`, mas não aparece na tela | Problema no frontend/socket |
| Nem conversa é criada e `instanceTenant` está null | Primeiro passo: vincular a instância ao tenant (passo 1) |

---

## URLs base

- **Local:** `http://localhost:10001`
- **Produção:** `https://pappiatendente.com.br`

Se o painel estiver em domínio diferente (ex: app.pappiatendente.com.br), use a URL base correspondente nos `fetch`.
