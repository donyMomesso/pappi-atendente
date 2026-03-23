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
   - Via banco: deletar `Config` onde `key = 'baileys:auth:default'` (ou instanceId usado).
4. Reinicie o processo Baileys.

## Procedimento de restart

1. Parar o processo que roda Baileys.
2. Aguardar 5–10 segundos (WhatsApp libera a sessão).
3. Subir novamente.

## Limites de envio

- Por hora: 60 mensagens
- Por dia: 200 mensagens
- Acima disso, envios são bloqueados até o reset.
