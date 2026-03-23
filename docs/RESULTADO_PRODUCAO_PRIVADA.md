# Resultado — Produção Privada

## 1. RESUMO EXECUTIVO

### O que foi alterado

| Área | Alteração | Motivo |
|------|-----------|--------|
| **Ambientes** | `.env.production.example`, `.env.staging.example`, `docs/ENVIRONMENTS.md` | Separação clara dev/staging/prod |
| **Processos** | `src/startup.js`, `src/bootstrap/{http,jobs,baileys}.js` | Desacoplamento para processos separados |
| **App** | Baileys e Jobs movidos para `startup.js`, chamado por `index.js` | Controle condicional via RUN_JOBS, RUN_BAILEYS |
| **Baileys** | BAILEYS_ENABLED, proteção initAll duplicado, logs estruturados | Evitar 440, melhor diagnóstico |
| **Segurança** | Helmet em produção, `/ready` com token opcional | Headers de segurança, healthcheck privado |
| **Config** | Novas variáveis: BAILEYS_ENABLED, RUN_JOBS, RUN_BAILEYS, HEALTHCHECK_TOKEN, etc | Controle fino por ambiente |
| **Scripts** | `start:web`, `start:jobs`, `start:baileys`, `healthcheck`, `migrate:deploy` | Operação clara |
| **Deploy** | Dockerfile, docker-compose.production/staging, ecosystem.config.js | Múltiplas opções de deploy |
| **Docs** | 12 novos documentos em `docs/` | Operação e checklists |

### Riscos mitigados

- **440 Baileys:** proteção contra init duplicado, WEB_CONCURRENCY=1 documentado
- **Mistura de ambientes:** exemplos de env separados, docs de isolamento
- **Deploy inseguro:** checklists, procedimento de rollback
- **Falta de observabilidade:** /health, /ready, logs por serviço

---

## 2. ARQUITETURA FINAL

### Processos

```
Modo Monólito (padrão):
  index.js → runStartup() + HTTP server
  └── Baileys (se RUN_BAILEYS)
  └── Jobs (se RUN_JOBS)
  └── Express + Socket.io

Modo Separado:
  pappi-web    → src/bootstrap/http.js   (HTTP + Socket, sem Baileys/Jobs)
  pappi-jobs   → src/bootstrap/jobs.js   (schedulers)
  pappi-baileys → src/bootstrap/baileys.js (WhatsApp QR)
```

### Fluxo

- `index.js`: valida env, chama `runStartup()`, sobe HTTP
- `runStartup()`: inicia Baileys e Jobs conforme RUN_BAILEYS e RUN_JOBS
- `bootstrap/http.js`: só HTTP, para processo web isolado
- `bootstrap/jobs.js`: só schedulers
- `bootstrap/baileys.js`: só Baileys

---

## 3. CONFIGURAÇÕES MANUAIS PENDENTES

### Variáveis (produção)

- `DATABASE_URL`, `DIRECT_URL` — banco real
- `ATTENDANT_API_KEY`, `ADMIN_API_KEY` — chaves fortes
- `WEBHOOK_VERIFY_TOKEN` — token Meta
- `GEMINI_API_KEY`, `GOOGLE_MAPS_API_KEY`
- `SUPABASE_*` — auth corporativa
- `CORS_ORIGIN` — domínio do app (sem `*`)
- `WEB_CONCURRENCY=1`

### Servidor

- Node.js 18+
- Postgres (Supabase, Neon, etc)
- SSL/HTTPS
- Firewall (portas 80/443, 10000 se exposto)

### Banco

- Schemas `auth` e `public`
- Migrations: `npx prisma migrate deploy`

### Domínio e SSL

- DNS para api.* e app.*
- Certificado (Let's Encrypt ou gerenciado)

### Backup

- Backup diário do banco
- Retenção mínima 7 dias
- Teste de restore periódico

---

## 4. PASSO A PASSO DE SUBIDA

### Homologação (staging)

1. `cp .env.staging.example .env.staging`
2. Editar `.env.staging` com dados de teste
3. `docker-compose -f docker-compose.staging.yml up -d`
4. `npx prisma db push` (ou migrate) no banco staging
5. Acessar `http://localhost:10001`
6. Escanear QR Baileys no painel

### Produção

1. Criar banco de produção (Supabase/Neon)
2. `cp .env.production.example .env`
3. Editar `.env` com valores reais
4. `npx prisma migrate deploy`
5. `npm start` (monólito) OU `pm2 start ecosystem.config.js` (separado)
6. Configurar proxy reverso (Nginx) se necessário
7. Verificar `/health` e Baileys conectado

---

## 5. ALERTAS IMPORTANTES

### O que NÃO fazer em produção

- **Não** usar `WEB_CONCURRENCY>1` com Baileys ativo
- **Não** rodar dois processos com Baileys no mesmo banco/auth
- **Não** usar `CORS_ORIGIN=*` em produção
- **Não** commitar `.env` com dados reais
- **Não** misturar banco de staging e produção
- **Não** fazer migration sem backup

### Pontos de atenção

- Baileys 440: sempre significa múltiplas sessões — revisar processos
- Backup antes de migrations estruturais
- Rotacionar chaves periodicamente
- Logs em produção: não expor tokens ou senhas
