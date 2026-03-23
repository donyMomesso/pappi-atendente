# Baileys 440 — Diagnóstico e Correção

## O que é o erro 440?

O código **440** (DisconnectReason.connectionReplaced) no Baileys significa **sessão substituída**: outra conexão assumiu o mesmo número WhatsApp. O WhatsApp não permite duas sessões ativas simultâneas para o mesmo número.

## Causas principais do 440

1. **Dois processos conectando o mesmo número**
   - Web e Baileys no mesmo processo com restarts
   - WEB_CONCURRENCY > 1 (múltiplos workers)
   - Deploy em paralelo (novo processo sobe antes do antigo morrer)

2. **Prod e homolog compartilhando sessão**
   - Mesmo banco de dados
   - Chaves de auth sem namespace por ambiente (`baileys:auth:default` em vez de `baileys:auth:prod:default`)

3. **Boot duplicado**
   - `index.js` (monólito) iniciava Baileys
   - Render usava `node index.js` → web + Baileys no mesmo processo
   - Ao fazer deploy, dois processos podem disputar durante a transição

4. **Sem lock entre processos**
   - Dois processos podiam tentar iniciar a mesma instância ao mesmo tempo

## O que foi corrigido

### 1. Boot isolado

- **Web** (`src/bootstrap/http.js`): `RUN_BAILEYS=false` — não inicia Baileys
- **Baileys** (`src/bootstrap/baileys.js`): processo dedicado, único responsável pela conexão
- **Monólito** (`index.js`): ainda suporta web + jobs + Baileys para dev local

### 2. Namespace da auth por ambiente

Chaves no banco:

- Antes: `baileys:auth:${instanceId}`
- Depois: `baileys:auth:${APP_ENV}:${instanceId}` (ex: `baileys:auth:prod:default`)

`APP_ENV` deve ser distinto: `prod`, `staging`, `dev`, `local`. Assim prod e homolog não compartilham sessão.

### 3. Lock de instância

O serviço `baileys-lock.service.js` implementa lock no banco:

- Chave: `baileys:lock:${APP_ENV}:${instanceId}`
- TTL: `BAILEYS_LOCK_TTL_MS` (padrão 60s)
- Se outro processo já tem o lock, o atual **não** inicia Baileys
- Heartbeat mantém o lock enquanto conectado

### 4. Tratamento do 440

- Logs estruturados com `instanceId`, `appEnv`, `hostname`, `pid`
- Status `conflict` — para retry automático, exige "Conectar" manual no painel
- `BAILEYS_CLEAR_AUTH_ON_440`: opcional — limpa auth e exige novo QR

### 5. Variáveis de ambiente

| Variável                  | Descrição                                 | Exemplo   |
|---------------------------|-------------------------------------------|-----------|
| APP_ENV                   | Ambiente (prod, staging, dev, local)      | prod      |
| RUN_BAILEYS               | Este processo inicia Baileys?             | true/false|
| RUN_JOBS                  | Este processo inicia jobs?                | true/false|
| BAILEYS_ENABLED           | Baileys habilitado globalmente            | true      |
| BAILEYS_LOCK_TTL_MS       | TTL do lock (ms)                          | 60000     |
| BAILEYS_PROCESS_NAME      | Nome do processo (logs)                   | pappi-baileys |
| BAILEYS_HOSTNAME          | Hostname (logs e owner)                   | auto      |
| BAILEYS_CLEAR_AUTH_ON_440 | Limpar auth ao receber 440                | true/false|

## Como rodar corretamente

### Produção (Render)

- **Web**: `node src/bootstrap/http.js` — `RUN_BAILEYS=false`, `RUN_JOBS=true`, `APP_ENV=prod`
- **Worker Baileys**: `node src/bootstrap/baileys.js` — `RUN_BAILEYS=true`, `RUN_JOBS=false`, `APP_ENV=prod`

O `render.yaml` já está configurado com os dois serviços.

### Homologação

- Banco **separado** de produção
- `APP_ENV=staging`
- Mesma separação de processos (web sem Baileys, worker Baileys)

### Local (desenvolvimento)

- Monólito: `npm run dev` ou `node index.js` — web + jobs + Baileys no mesmo processo
- Ou separado: `npm run start:web` em um terminal, `npm run start:baileys` em outro

## O que NUNCA fazer

1. **Rodar Baileys em mais de um processo** com o mesmo `APP_ENV` e mesma instância
2. **Usar o mesmo banco** para prod e staging sem `APP_ENV` diferente
3. **Definir WEB_CONCURRENCY > 1** no processo que roda Baileys
4. **Deploy sem garantir** que o processo antigo já encerrou

## Quando o 440 acontecer

1. **Verifique os logs** — `instanceId`, `appEnv`, `hostname`, `pid`, `owner`
2. **Confirme**: só um processo está rodando Baileys para aquela instância?
3. **Confirme**: prod e staging têm `APP_ENV` diferente?
4. **No painel**: use "Conectar" para retentar (não faz retry automático após 440)
5. **Se persistir sem causa clara**: `BAILEYS_CLEAR_AUTH_ON_440=true` + novo QR

## Quando limpar auth e quando não limpar

| Situação                             | Limpar auth? |
|--------------------------------------|--------------|
| 440 por processo duplicado           | Não — corrija a arquitetura |
| 440 por prod+staging mesmo banco     | Não — defina APP_ENV e use bancos separados |
| 440 "fantasma" (nenhum celular ativo) | Sim — `BAILEYS_CLEAR_AUTH_ON_440=true` ou limpe manual |
| Logout explícito (401)               | Sim — sempre limpa automaticamente |

## Scripts úteis

```bash
# Diagnóstico
node check-wa-status.js

# Processos separados
npm run start:web     # Só web/API
npm run start:baileys # Só Baileys
npm run start:jobs    # Só jobs (opcional)
```

## Arquivos alterados (resumo)

- `src/services/baileys.service.js` — lock, namespace, logs 440
- `src/services/baileys-db-auth.js` — auth com APP_ENV
- `src/services/baileys-lock.service.js` — novo
- `src/config/env.js` — APP_ENV, BAILEYS_*
- `src/bootstrap/http.js` — RUN_BAILEYS=false
- `src/bootstrap/baileys.js` — processo dedicado
- `src/routes/dashboard.routes.js` — disconnect async
- `check-wa-status.js` — auth por ambiente
- `render.yaml` — web + worker, APP_ENV
- `.env.example`, `.env.production.example`, `.env.staging.example`
