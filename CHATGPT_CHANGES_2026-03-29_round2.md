# Ajustes 2026-03-29 — rodada 2

## Corrigido
- Toggle de bot/handoff agora assume imediatamente o atendimento humano no painel, evitando que o bot continue respondendo por falta de `claimedBy`.
- Histórico do chat no painel:
  - mensagens do bot agora aparecem do lado de saída;
  - eco outbound do WhatsApp não duplica mais no socket.
- Auditoria do painel:
  - a aba deixou de ser placeholder;
  - agora consome `GET /dash/audit-logs` e renderiza a lista.
- Horários:
  - respostas de horário agora incluem a lista semanal do Cardápio Web quando disponível.
- Sincronização de pedidos do Cardápio Web:
  - ao buscar histórico do cliente, pedidos encontrados no CW passam por backfill para o banco local;
  - pedidos já existentes têm status/itens/totais atualizados.

## Arquivos principais alterados
- `public/index.html`
- `src/routes/webhook.routes.js`
- `src/routes/dashboard.routes.js`
- `src/routes/bot.handler.js`
