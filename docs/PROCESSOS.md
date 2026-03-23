# Processos — Arquitetura de Execução

## Visão geral

O Pappi Atendente pode rodar em dois modos:

1. **Monólito** — um único processo (web + jobs + Baileys)
2. **Separado** — três processos: web, jobs, Baileys

## Modo monólito (padrão)

```bash
npm start
# ou
node index.js
```

Inicia: servidor HTTP, Socket.io, Baileys, todos os schedulers.

## Modo separado

Útil para:
- Escalar web sem reiniciar Baileys
- Rodar jobs em servidor dedicado
- Isolar falhas

### Processo Web

```bash
npm run start:web
# ou
node src/bootstrap/http.js
```

- Servidor HTTP + Socket.io
- Rotas (webhook, dash, admin, etc)
- **Não** inicia Baileys nem Jobs

### Processo Jobs

```bash
npm run start:jobs
# ou
node src/bootstrap/jobs.js
```

- Retention
- CW Retry
- Order Delay Monitor
- Avise Abertura
- Handoff Timeout

### Processo Baileys

```bash
npm run start:baileys
# ou
node src/bootstrap/baileys.js
```

- WhatsApp QR
- **WEB_CONCURRENCY=1** obrigatório no ambiente

## PM2 (exemplo)

```javascript
// ecosystem.config.js
module.exports = {
  apps: [
    { name: "pappi-web", script: "src/bootstrap/http.js", instances: 1 },
    { name: "pappi-jobs", script: "src/bootstrap/jobs.js", instances: 1 },
    { name: "pappi-baileys", script: "src/bootstrap/baileys.js", instances: 1 },
  ],
};
```

## Variáveis de controle

| Variável | Uso |
|----------|-----|
| `RUN_JOBS` | Este processo executa schedulers |
| `RUN_BAILEYS` | Este processo inicia Baileys |
| `BAILEYS_ENABLED` | Baileys ativo no sistema |
| `WEB_CONCURRENCY` | Workers HTTP (sempre 1 se Baileys no mesmo host) |
