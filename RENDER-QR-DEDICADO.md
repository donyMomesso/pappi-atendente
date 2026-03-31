# Render pago — QR/Baileys dedicado

Esta versão foi preparada para rodar com QR/Baileys separado do web.

## Arquitetura recomendada
- `pappi-atendente-web`: painel, API, Socket.IO e jobs
- `pappi-atendente-baileys`: somente QR/Baileys

## Variáveis principais
### Web
- `APP_RUNTIME=web`
- `BAILEYS_INSTANCE_MODE=dedicated`
- `RUN_BAILEYS=false`
- `RUN_JOBS=true`

### Worker Baileys
- `APP_RUNTIME=baileys`
- `BAILEYS_INSTANCE_MODE=dedicated`
- `RUN_BAILEYS=true`
- `RUN_JOBS=false`
- `WEB_CONCURRENCY=1`

## O que muda
- o web não sobe Baileys por acidente
- o worker Baileys não disputa socket com o painel
- o lock por instância continua valendo
- auth permanece no banco

## Observação
Ainda é QR/Baileys, então não vira Cloud API. Mas esta separação reduz muito queda causada por restart do painel, boot duplicado e disputa de processo.
