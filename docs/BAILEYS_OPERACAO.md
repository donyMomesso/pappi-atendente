# Baileys — Operação em Produção Privada

## Visão geral

O Baileys é o WhatsApp QR (não-oficial) usado para notificações internas e, em alguns fluxos, atendimento. É **crítico** para a operação.

## Regra de ouro: 1 processo, 1 sessão

- **WEB_CONCURRENCY=1** — obrigatório quando Baileys está ativo.
- Múltiplos processos = erro 440 (sessão substituída).
- Nunca subir duas instâncias do app com Baileys apontando para o mesmo banco/auth.

## Modos de execução

| Modo | Descrição | Quando usar |
|------|-----------|-------------|
| **Monólito** | Web + Jobs + Baileys no mesmo processo | Desenvolvimento, Render free |
| **Separado** | Web, Jobs e Baileys em processos distintos | Produção com mais controle |

## Inicialização

- `BAILEYS_ENABLED=true` (default) — Baileys inicia
- `BAILEYS_ENABLED=false` — Baileys não inicia
- `RUN_BAILEYS=true` (default) — este processo inicia Baileys

## Logs importantes

| Evento | Log | Ação |
|--------|-----|------|
| QR gerado | `QR Code gerado — escaneie no WhatsApp` | Escanear no app |
| Conectado | `Baileys conectado com sucesso` | Operação normal |
| Logout 401 | `Logout detectado — limpando auth` | Reescaneiar QR |
| 440 (1–2x) | `Sessão 440 — reconectando após delay` | Aguardar reconexão |
| 440 (3x) | `Sessão 440 — parando reconexão` | Recuperação manual |
| Conexão fechada | `Conexão fechada — reconectando em 8s` | Reconexão automática |

## Recuperação manual (440 persistente)

1. Verifique se não há outro processo rodando com o mesmo Baileys.
2. Confirme `WEB_CONCURRENCY=1` no ambiente.
3. Se necessário, limpe o auth e gere novo QR:
   - Via painel: desconectar instância e reconectar.
   - Via banco: deletar `Config` onde `key = 'baileys:auth:{APP_ENV}:default'` (ex: `baileys:auth:prod:default`).
4. Verifique `docs/BAILEYS_440.md` para causas raiz e configuração.
5. Reinicie o processo Baileys dedicado.

## Procedimento de restart

1. Parar o processo que roda Baileys.
2. Aguardar 5–10 segundos (WhatsApp libera a sessão).
3. Subir novamente.

## Limites de envio

- Por hora: 60 mensagens
- Por dia: 200 mensagens
- Acima disso, envios são bloqueados até o reset.

---

## Conexão caindo toda hora — diagnóstico

### Causas comuns

| Causa | Sintoma | Solução |
|-------|---------|---------|
| **Render free tier** | App dorme após 15 min inativo, conexão cai ao acordar | Usar cron externo (cron-job.org) para pingar `/health` a cada 10–12 min; ou plano pago |
| **440 (sessão substituída)** | Log mostra "Sessão 440" | Só 1 processo com Baileys; `WEB_CONCURRENCY=1`; fechar WhatsApp Web no navegador |
| **Dois ambientes** | Dev local + produção com mesmo número | Rodar Baileys em apenas um; ou usar instâncias diferentes |
| **Rede instável** | Códigos 408, 503, "Stream Errored" | Backoff exponencial já implementado (8s→16s→32s→60s→120s) |
| **Logout 401** | "Logout detectado" | Reescaneie o QR no painel |

### O que verificar

1. **WEB_CONCURRENCY=1** no Render e em todos os ambientes
2. **Apenas um processo** usando o Baileys (não rodar dev e prod ao mesmo tempo com o mesmo auth)
3. **WhatsApp Web** fechado no navegador se estiver usando o mesmo número
4. **Logs** — o código de desconexão aparece em `Baileys desconectado: code XXX`; anote para diagnóstico

### Render free tier

O plano free **dorme** após ~15 min sem requisições. Ao dormir:
- O processo é encerrado
- A conexão Baileys cai
- Ao acordar (nova requisição), o app reinicia e tenta reconectar

**Mitigação:** Configure um cron job gratuito para fazer GET em `https://seu-app.onrender.com/health` a cada 10 minutos.
