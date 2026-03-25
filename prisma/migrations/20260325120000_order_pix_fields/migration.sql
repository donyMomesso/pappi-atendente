-- Add PIX fields for pending payment flow (Inter)
ALTER TABLE "public"."orders"
  ADD COLUMN IF NOT EXISTS "pixTxid" TEXT,
  ADD COLUMN IF NOT EXISTS "pixE2eId" TEXT,
  ADD COLUMN IF NOT EXISTS "pixStatus" TEXT;

-- Unique txid to map webhook -> order
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='orders_pixTxid_key'
  ) THEN
    CREATE UNIQUE INDEX "orders_pixTxid_key" ON "public"."orders"("pixTxid");
  END IF;
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
END $$;

