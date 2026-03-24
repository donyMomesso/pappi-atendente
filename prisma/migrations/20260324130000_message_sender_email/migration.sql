-- AlterTable Message.senderEmail (opcional; linhas antigas = NULL)
-- Idempotente: seguro reexecutar em produção (PostgreSQL 11+).
ALTER TABLE "public"."messages" ADD COLUMN IF NOT EXISTS "senderEmail" TEXT;
