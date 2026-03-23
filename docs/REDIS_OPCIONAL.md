# Redis Opcional

## Status

O Redis **não está implementado** no projeto atual. Rate limit e locks usam memória.

## Evolução futura

Se precisar de:
- Rate limit distribuído (múltiplos processos)
- Locks entre processos
- Filas leves

Adicione `REDIS_URL` e implemente adaptadores com fallback em memória.

## Variável

```
REDIS_URL=redis://localhost:6379
```

Se não configurado, o sistema funciona normalmente com storage em memória.
