-- Preserve backward compatibility: only additive changes.
-- 1) Message original provider timestamp
-- 2) Customer identity lookup indexes (wa_id, wa_user_id, etc.)

ALTER TABLE "public"."messages"
ADD COLUMN IF NOT EXISTS "original_timestamp" TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "messages_customer_original_ts"
ON "public"."messages" ("customerId", "original_timestamp");

CREATE INDEX IF NOT EXISTS "idx_customers_tenant_wa_id"
ON "public"."customers" ("tenantId", "wa_id");

CREATE INDEX IF NOT EXISTS "idx_customers_tenant_wa_user_id"
ON "public"."customers" ("tenantId", "wa_user_id");

CREATE INDEX IF NOT EXISTS "idx_customers_tenant_wa_username"
ON "public"."customers" ("tenantId", "wa_username");

CREATE INDEX IF NOT EXISTS "idx_customers_tenant_wa_parent_user_id"
ON "public"."customers" ("tenantId", "wa_parent_user_id");
