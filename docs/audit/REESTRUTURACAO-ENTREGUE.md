# Auditoria de reestruturação do Pappi Atendente

## Remoções aplicadas

- `.claude/` removido (configuração de IDE/assistente, sem uso em runtime).
- `AGENTS.md` removido (documentação de assistente, sem uso pelo sistema).
- `CLAUDE.md` removido (documentação de assistente, sem uso pelo sistema).
- `CHATGPT_CHANGES_*.md` removidos (anotações de suporte, sem uso pelo sistema).

## Mudanças estruturais implementadas

- Validação de assinatura Meta em `src/middleware/webhook-signature.middleware.js`.
- `express.json` agora preserva `rawBody` para checagem criptográfica do webhook.
- Autenticação por API key endurecida: sem `query.key` e sem tenant padrão implícito.
- `META_APP_SECRET` adicionado ao `src/config/env.js`.
- Duplo check CardápioWeb antes de `createOrder`, validando itens e formas de pagamento ativas.

## Inventário pasta a pasta

### src/
- `src/app.js` — 5187 bytes
- `src/bootstrap/baileys.js` — 1843 bytes
- `src/bootstrap/http.js` — 1809 bytes
- `src/bootstrap/jobs.js` — 1448 bytes
- `src/calculators/OrderCalculator.js` — 1321 bytes
- `src/config/env.js` — 6641 bytes
- `src/lib/attendants-config.js` — 1943 bytes
- `src/lib/baileys-message-content.js` — 7032 bytes
- `src/lib/db.js` — 1333 bytes
- `src/lib/logger.js` — 1082 bytes
- `src/lib/message-db-compat.js` — 5253 bytes
- `src/lib/meta-telemetry.js` — 2761 bytes
- `src/lib/order-pix-db-compat.js` — 5663 bytes
- `src/lib/rate-limiter.js` — 2308 bytes
- `src/lib/retry.js` — 1623 bytes
- `src/lib/timing.js` — 1101 bytes
- `src/lib/validate-env.js` — 2329 bytes
- `src/lib/wa-webhook-identity.js` — 3271 bytes
- `src/lib/whatsapp.js` — 6693 bytes
- `src/mappers/PaymentMapper.js` — 2749 bytes
- `src/middleware/auth.middleware.js` — 5883 bytes
- `src/middleware/authorization.middleware.js` — 2368 bytes
- `src/middleware/tenant.middleware.js` — 542 bytes
- `src/middleware/webhook-signature.middleware.js` — 1430 bytes
- `src/normalizers/AddressNormalizer.js` — 2557 bytes
- `src/normalizers/PhoneNormalizer.js` — 1125 bytes
- `src/routes/admin-users.routes.js` — 7665 bytes
- `src/routes/admin.routes.js` — 6178 bytes
- `src/routes/auth.routes.js` — 4877 bytes
- `src/routes/bot.handler.js` — 95815 bytes
- `src/routes/dashboard.routes.js` — 101008 bytes
- `src/routes/diag.routes.js` — 10809 bytes
- `src/routes/internal.routes.js` — 1564 bytes
- `src/routes/orders.routes.js` — 7133 bytes
- `src/routes/pix.routes.js` — 5721 bytes
- `src/routes/staff-users.routes.js` — 10145 bytes
- `src/routes/webhook.routes.js` — 26209 bytes
- `src/rules/base.md` — 560 bytes
- `src/rules/event.md` — 136 bytes
- `src/rules/loader.js` — 706 bytes
- `src/rules/promo.md` — 190 bytes
- `src/rules/vip.md` — 294 bytes
- `src/services/ai-motor.service.js` — 8494 bytes
- `src/services/ai-orchestrator.service.js` — 8865 bytes
- `src/services/ai.service.js` — 219 bytes
- `src/services/audio-synthesis.service.js` — 1103 bytes
- `src/services/audio-transcribe.service.js` — 3238 bytes
- `src/services/audit-log.service.js` — 1297 bytes
- `src/services/audit.service.js` — 199 bytes
- `src/services/auth.service.js` — 7044 bytes
- `src/services/avise-abertura-scheduler.js` — 1447 bytes
- `src/services/avise-abertura.service.js` — 4508 bytes
- `src/services/baileys-db-auth.js` — 2579 bytes
- `src/services/baileys-lock.service.js` — 3626 bytes
- `src/services/baileys.service.js` — 82817 bytes
- `src/services/bot-learning.service.js` — 12678 bytes
- `src/services/cardapio-double-check.service.js` — 4331 bytes
- `src/services/cardapio.service.js` — 17552 bytes
- `src/services/cart-pricing.service.js` — 9565 bytes
- `src/services/chat-memory.service.js` — 6387 bytes
- `src/services/context.service.js` — 558 bytes
- `src/services/conversation-state.service.js` — 2613 bytes
- `src/services/coupon.service.js` — 1927 bytes
- `src/services/customer.service.js` — 10820 bytes
- `src/services/cw-retry.service.js` — 5219 bytes
- `src/services/deescalation.service.js` — 745 bytes
- `src/services/disc.service.js` — 1794 bytes
- `src/services/gemini.service.js` — 19309 bytes
- `src/services/google-contacts.service.js` — 5692 bytes
- `src/services/groq-fallback.service.js` — 1594 bytes
- `src/services/handoff-timeout-scheduler.js` — 1507 bytes
- `src/services/inbox-triage.service.js` — 2907 bytes
- `src/services/inter-pix.service.js` — 3783 bytes
- `src/services/maps.service.js` — 1819 bytes
- `src/services/message-buffer.service.js` — 4036 bytes
- `src/services/message-retention.service.js` — 1469 bytes
- `src/services/meta-capi.service.js` — 6538 bytes
- `src/services/meta-social.service.js` — 12188 bytes
- `src/services/openai-fallback.service.js` — 1595 bytes
- `src/services/order-delay-monitor.service.js` — 10632 bytes
- `src/services/order-delay.service.js` — 4870 bytes
- `src/services/order-intake.service.js` — 5280 bytes
- `src/services/order.service.js` — 5499 bytes
- `src/services/retention.service.js` — 6186 bytes
- `src/services/sentiment.service.js` — 6117 bytes
- `src/services/session.service.js` — 3714 bytes
- `src/services/socket.service.js` — 2127 bytes
- `src/services/staff-invite.service.js` — 2425 bytes
- `src/services/staff-user.service.js` — 5968 bytes
- `src/services/supabase-auth.service.js` — 3039 bytes
- `src/services/tenant.service.js` — 4344 bytes
- `src/services/time-routing.service.js` — 3984 bytes
- `src/services/upsell.service.js` — 790 bytes
- `src/services/weather.service.js` — 2430 bytes
- `src/startup.js` — 2403 bytes

### prisma/
- `prisma/full-schema.sql` — 123358 bytes
- `prisma/migration-v3.1.0.sql` — 781 bytes
- `prisma/migrations/20250320000000_add_order_delay_fields/migration.sql` — 1976 bytes
- `prisma/migrations/20250320100000_add_staff_auth/migration.sql` — 2295 bytes
- `prisma/migrations/20260224120000_staff_invites_profile/migration.sql` — 1191 bytes
- `prisma/migrations/20260324130000_message_sender_email/migration.sql` — 211 bytes
- `prisma/migrations/20260324140000_ensure_public_messages_table/migration.sql` — 1161 bytes
- `prisma/migrations/20260325120000_order_pix_fields/migration.sql` — 558 bytes
- `prisma/migrations/20260325183000_customer_wa_identity/migration.sql` — 991 bytes
- `prisma/migrations/20260326103000_message_original_timestamp_and_customer_identity_indexes/migration.sql` — 844 bytes
- `prisma/pappi-init-public.sql` — 10609 bytes
- `prisma/schema.prisma` — 34242 bytes
- `prisma/seed.js` — 3563 bytes

### public/
- `public/favicon.ico` — 15406 bytes
- `public/index.html` — 277079 bytes
- `public/logo.png` — 110300 bytes
- `public/privacy.html` — 5365 bytes
- `public/status.html` — 1666 bytes

### scripts/
- `scripts/add-google-user.js` — 1307 bytes
- `scripts/create-first-admin.js` — 2324 bytes
- `scripts/create-staff-admin.js` — 1573 bytes
- `scripts/list-google-users.js` — 414 bytes
- `scripts/set-social-config.js` — 2401 bytes

### tests/
- `tests/address-normalizer.test.js` — 2539 bytes
- `tests/conversation-state.test.js` — 4630 bytes
- `tests/conversation.fuzz.test.js` — 19708 bytes
- `tests/lib/conversation-fuzz.generator.js` — 6238 bytes
- `tests/order-calculator.test.js` — 2893 bytes
- `tests/phone-normalizer.test.js` — 2255 bytes
- `tests/rate-limiter.test.js` — 2141 bytes
- `tests/reconnect-backlog-guard.test.js` — 3497 bytes
- `tests/sanitize-input.test.js` — 1965 bytes

### docs/
- `docs/AUTH-CORPORATE.md` — 3711 bytes
- `docs/BAILEYS_440.md` — 5748 bytes
- `docs/BAILEYS_OPERACAO.md` — 3700 bytes
- `docs/BANCO_E_MIGRATIONS.md` — 752 bytes
- `docs/CHECKLIST_DEPLOY.md` — 468 bytes
- `docs/CHECKLIST_GO_LIVE.md` — 765 bytes
- `docs/CHECKLIST_ROLLBACK.md` — 593 bytes
- `docs/DEBUG-BAILEYS-CHECKLIST.md` — 3884 bytes
- `docs/DEPLOY_PRIVATE_PRODUCTION.md` — 1456 bytes
- `docs/DIAGNOSTICO-HIBRIDO.md` — 5434 bytes
- `docs/ENVIRONMENTS.md` — 2356 bytes
- `docs/FASE-1-MODELAGEM.md` — 2342 bytes
- `docs/FASE-2-SERVICOS.md` — 2537 bytes
- `docs/FASE-3-AUTENTICACAO.md` — 1986 bytes
- `docs/FASE-4-MIDDLEWARES.md` — 1667 bytes
- `docs/FASE-5-ROTAS.md` — 2539 bytes
- `docs/FASE-6-FRONTEND.md` — 1937 bytes
- `docs/FASE-7-GESTAO-USUARIOS.md` — 1219 bytes
- `docs/FASE-8-PRODUCAO.md` — 2423 bytes
- `docs/FASE-9-MIGRACAO-FINAL.md` — 2068 bytes
- `docs/OBSERVABILIDADE.md` — 791 bytes
- `docs/ORDER-DELAY-MONITORING.md` — 3087 bytes
- `docs/PLANO-HIBRIDO.md` — 3855 bytes
- `docs/PROCESSOS.md` — 1593 bytes
- `docs/REDIS_OPCIONAL.md` — 450 bytes
- `docs/RELATORIO-DIAGNOSTICO.md` — 12043 bytes
- `docs/RESULTADO_PRODUCAO_PRIVADA.md` — 4206 bytes
- `docs/RESUMO-HIBRIDO.md` — 4655 bytes
- `docs/ROTINA_BACKUP.md` — 679 bytes
- `docs/SECURITY_PRIVATE_APP.md` — 1109 bytes
