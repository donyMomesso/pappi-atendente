# Variáveis de ambiente para o Render

## ⚠️ WEB_CONCURRENCY=1 (obrigatório para Baileys)

O Baileys usa uma única sessão WhatsApp por número. Se mais de um processo usar a mesma auth, ocorre loop de **440 (Sessão substituída)**.

O `render.yaml` já define `WEB_CONCURRENCY=1`. **Não altere** — mantém 1 único processo Node.

---

## Para login por chave + QR do Baileys
Defina `ALLOW_API_KEY_FALLBACK=true` para aceitar API key no painel (e na URL do QR).

## ⚠️ OBRIGATÓRIO: Connection Pooling

O Render **não consegue** conectar em `db.xxx.supabase.co:5432` (conexão direta).
Use as URLs do **pooler**:

### DATABASE_URL
```
postgresql://postgres.pklltcsxsadjbqjurzmc:R.L%2F5x8%26%25hgQLYU@aws-1-sa-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true
```

### DIRECT_URL
```
postgresql://postgres.pklltcsxsadjbqjurzmc:R.L%2F5x8%26%25hgQLYU@aws-1-sa-east-1.pooler.supabase.com:5432/postgres
```

---

## Como atualizar no Render

1. Acesse **Render Dashboard** → seu serviço **pappi-atendente**
2. **Environment** → **Edit**
3. Altere **DATABASE_URL** e **DIRECT_URL** pelos valores acima
4. **Save Changes** → o Render fará um novo deploy

---

## Build Command (se der P3005)

Troque para:
```
npm install && npx prisma generate && npx prisma db push
```
