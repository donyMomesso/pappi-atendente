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
