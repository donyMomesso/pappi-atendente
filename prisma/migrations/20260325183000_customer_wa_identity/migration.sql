-- WhatsApp: BSUID / username / wa_id; telefone opcional.
-- Mantém @@unique(tenantId, phone) do Prisma (PostgreSQL permite várias linhas com phone NULL).

ALTER TABLE "public"."customers" ALTER COLUMN "phone" DROP NOT NULL;

ALTER TABLE "public"."customers"
  ADD COLUMN IF NOT EXISTS "wa_id" TEXT,
  ADD COLUMN IF NOT EXISTS "wa_user_id" TEXT,
  ADD COLUMN IF NOT EXISTS "wa_parent_user_id" TEXT,
  ADD COLUMN IF NOT EXISTS "wa_username" TEXT,
  ADD COLUMN IF NOT EXISTS "identity_type" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "customers_tenantId_wa_user_id_key"
  ON "public"."customers" ("tenantId", "wa_user_id")
  WHERE "wa_user_id" IS NOT NULL AND "wa_user_id" <> '';

CREATE UNIQUE INDEX IF NOT EXISTS "customers_tenantId_wa_id_key"
  ON "public"."customers" ("tenantId", "wa_id")
  WHERE "wa_id" IS NOT NULL AND "wa_id" <> '';

CREATE INDEX IF NOT EXISTS "customers_tenant_wa_username_idx"
  ON "public"."customers" ("tenantId", "wa_username")
  WHERE "wa_username" IS NOT NULL;
