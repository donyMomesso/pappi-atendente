# Auditoria Enterprise

## Conferência do pacote enviado
- middleware de assinatura Meta: OK
- duplo check Cardápio Web: OK
- rawBody no Express: OK
- tenant default implícito: removido
- query.key em auth: removido

## Melhorias adicionadas nesta versão
- request context com `x-request-id`
- logging HTTP com duração
- métricas Prometheus
- idempotência de webhook
- bootstrap de worker enterprise
- Redis e BullMQ opcionais

## Observação
Os arquivos gigantes do domínio principal ainda foram preservados para não quebrar os fluxos atuais.
