# Variáveis de ambiente para o Render

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
