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
