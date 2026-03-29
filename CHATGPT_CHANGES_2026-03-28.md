# Ajustes aplicados em 2026-03-28

## Áudio
- Preferência de áudio do cliente agora deixa de ser sobrescrita para `false` a cada mensagem de texto.
- Respostas em áudio agora passam por filtro para evitar duplicação em mensagens longas, com links, PIX e botões.
- Download de áudio ganhou timeout defensivo.
- Transcrição ignora arquivos muito curtos e remove checagem incorreta de `GROQ_API_KEY` como requisito de transcrição.

## Observações do pedido
- Observações digitadas pelo cliente durante `ORDERING`, `PAYMENT` e `CONFIRM` passam a ser capturadas e mescladas no pedido.
- Resumo de pagamento exibe a observação antes da confirmação.
- Payload enviado ao Cardápio Web continua levando `observation`.
- Tela do painel passa a exibir observações do pedido quando disponíveis.
- Criação manual de pedido pelo painel ganhou campo de observação.
- Pedidos do painel passam a combinar observação manual + troco no campo `observation` do payload CW.

## Cardápio Web
- Cache de catálogo e cache de meios de pagamento agora usam timestamps separados.
- Catálogo agora é enriquecido com estrutura normalizada (`_normalized`) para reduzir inconsistência entre formatos `categories`, `sections` e similares.
- `prefilled_order` agora resolve produtos usando a versão normalizada do catálogo.

## Observações importantes
- Não rodei a suíte Jest porque as dependências não estão instaladas neste ambiente (`jest: not found`).
- Validei sintaxe com `node --check` nos arquivos JS alterados.
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
# Rodada 3 — Conversa mais humana e menos travada

## O que foi ajustado

### Saudação e abertura da conversa
- removi a abertura em formato de questionário logo após o "oi"
- a saudação agora fica mais humana e contínua
- cliente recorrente recebe abertura mais natural, sem "escolha uma opção"
- o link do Cardápio Web continua presente, mas de forma mais suave

### Fluxo de conversa
- prompts de pizza/lasanha e entrega/retirada ficaram em texto livre
- fallback de triagem agora convida o cliente a falar normalmente
- retomada após irritação/de-escalation agora volta em linguagem natural
- início do pedido agora pede a frase completa do cliente, como um atendente faria

### Endereço e área de entrega
- reduzi falso negativo de "fora da área"
- quando o endereço parece próximo, o sistema deixa seguir mesmo sem taxa imediata
- quando não dá para validar a taxa na hora, o bot pede mais contexto em vez de barrar como fora de área
- validação final de taxa no fechamento ficou menos agressiva

### IA de saudação
- prompt da saudação foi ajustado para evitar texto robótico, menu e questionário
- a IA agora tende a responder em tom mais humano e convidativo

### Maps / cobertura
- `maps.service.js` não marca mais `is_serviceable=false` só porque a taxa não veio
- isso evita classificar endereço como fora da área sem prova real

## Arquivos principais alterados
- `src/routes/bot.handler.js`
- `src/services/gemini.service.js`
- `src/services/maps.service.js`

## Validação executada
- `node --check src/routes/bot.handler.js`
- `node --check src/services/gemini.service.js`
- `node --check src/services/maps.service.js`
# Ajustes aplicados em 2026-03-29

## Áudio
- preferência de áudio agora fica persistida na sessão; texto comum não desativa automaticamente
- resposta por áudio não duplica mais o texto em respostas comuns
- transcrição ganhou timeout de download
- transcrição não considera mais GROQ como provider de áudio
- proteção extra para arquivo maior que 10 MB antes/depois do download

## Cardápio Web
- catálogo agora volta enriquecido com:
  - `normalized_categories`
  - `flat_items`
  - `product_index_by_id`
- cache de catálogo separado do cache de métodos de pagamento

## Observações do pedido
- pedido manual do painel agora aceita observação geral
- itens do carrinho agora aceitam observação por item
- observações entram no payload do Cardápio Web e no snapshot local
- pedidos do cliente e kanban agora expõem observação
- painel mostra a observação no card do pedido

## Fluxo do bot
- `prefersAudio` agora persiste na sessão
- respostas em áudio usam fallback para texto só quando o TTS falha
