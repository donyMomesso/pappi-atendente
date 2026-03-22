-- AlterTable: add order delay monitoring fields to orders (Prisma camelCase)
ALTER TABLE "public"."orders" ADD COLUMN IF NOT EXISTS "cardapiowebStatus" TEXT;
ALTER TABLE "public"."orders" ADD COLUMN IF NOT EXISTS "statusChangedAt" TIMESTAMPTZ(6);
ALTER TABLE "public"."orders" ADD COLUMN IF NOT EXISTS "timeInCurrentStatusMinutes" INTEGER;
ALTER TABLE "public"."orders" ADD COLUMN IF NOT EXISTS "dailyAvgProdToOutMinutes" DOUBLE PRECISION;
ALTER TABLE "public"."orders" ADD COLUMN IF NOT EXISTS "dailyAvgOutToDoneMinutes" DOUBLE PRECISION;
ALTER TABLE "public"."orders" ADD COLUMN IF NOT EXISTS "estimatedRemainingMin" INTEGER;
ALTER TABLE "public"."orders" ADD COLUMN IF NOT EXISTS "estimatedRemainingMax" INTEGER;
ALTER TABLE "public"."orders" ADD COLUMN IF NOT EXISTS "weatherDelayFactor" DOUBLE PRECISION;
ALTER TABLE "public"."orders" ADD COLUMN IF NOT EXISTS "delayAlertSentAt" TIMESTAMPTZ(6);
ALTER TABLE "public"."orders" ADD COLUMN IF NOT EXISTS "secondDelayAlertSentAt" TIMESTAMPTZ(6);
ALTER TABLE "public"."orders" ADD COLUMN IF NOT EXISTS "thirdDelayAlertSentAt" TIMESTAMPTZ(6);
ALTER TABLE "public"."orders" ADD COLUMN IF NOT EXISTS "attendantAlertSentAt" TIMESTAMPTZ(6);
ALTER TABLE "public"."orders" ADD COLUMN IF NOT EXISTS "watchedByAttendant" TEXT;
ALTER TABLE "public"."orders" ADD COLUMN IF NOT EXISTS "deliveryRiskLevel" TEXT;
ALTER TABLE "public"."orders" ADD COLUMN IF NOT EXISTS "compensationEligible" BOOLEAN DEFAULT false;
ALTER TABLE "public"."orders" ADD COLUMN IF NOT EXISTS "compensationReason" TEXT;
ALTER TABLE "public"."orders" ADD COLUMN IF NOT EXISTS "compensationType" TEXT;
ALTER TABLE "public"."orders" ADD COLUMN IF NOT EXISTS "couponCode" TEXT;
ALTER TABLE "public"."orders" ADD COLUMN IF NOT EXISTS "couponGeneratedAt" TIMESTAMPTZ(6);
ALTER TABLE "public"."orders" ADD COLUMN IF NOT EXISTS "couponSentAt" TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "idx_orders_tenant_cw_status" ON "public"."orders"("tenantId", "cardapiowebStatus");
