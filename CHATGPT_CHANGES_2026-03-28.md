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
