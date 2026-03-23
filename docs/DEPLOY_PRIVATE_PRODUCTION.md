# Deploy — Produção Privada

## Opções de deploy

### 1. Monólito (Render, Railway, etc)

Um único processo: web + jobs + Baileys.

```bash
npm start
```

Configurar `WEB_CONCURRENCY=1`.

### 2. Docker

```bash
# Build
docker build -t pappi-atendente .

# Run (com .env)
docker run -d --env-file .env -p 10000:10000 pappi-atendente
```

Ou `docker-compose -f docker-compose.production.yml up -d`.

### 3. PM2 (processos separados)

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

### 4. Homologação (staging)

```bash
cp .env.staging.example .env.staging
# Editar .env.staging
docker-compose -f docker-compose.staging.yml up -d
```

## Ordem de subida

1. Banco (Postgres/Supabase)
2. Migrations: `npx prisma migrate deploy`
3. App: `npm start` ou PM2/Docker

## Nginx (exemplo)

```nginx
server {
    listen 80;
    server_name api.pappiatendente.com.br;
    location / {
        proxy_pass http://127.0.0.1:10000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Verificações

- `GET /health` → 200
- `GET /ready` → 200 (se token configurado)
- Baileys conectado (ver painel)
- Webhook Meta verificado
