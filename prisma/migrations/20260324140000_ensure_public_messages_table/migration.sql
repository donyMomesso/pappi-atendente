-- Garante public.messages em bancos legados.
-- O histórico Prisma/migrations não incluía baseline que criasse esta tabela (só ALTERs e senderEmail).
-- Init manual: prisma/pappi-init-public.sql (bloco messages).

CREATE TABLE IF NOT EXISTS "public"."messages" (
  "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
  "customerId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "sender" TEXT,
  "senderEmail" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "mediaUrl" TEXT,
  "mediaType" TEXT DEFAULT 'text',
  "waMessageId" TEXT,
  "status" TEXT DEFAULT 'sent',
  CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "messages_customer_created" ON "public"."messages"("customerId", "createdAt");
CREATE INDEX IF NOT EXISTS "idx_messages_wa_message_id" ON "public"."messages"("waMessageId");

DO $$
BEGIN
  ALTER TABLE "public"."messages"
    ADD CONSTRAINT "messages_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "public"."customers"("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_table THEN NULL;
END $$;
