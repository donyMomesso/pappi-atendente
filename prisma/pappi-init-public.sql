-- Pappi Atendente: tabelas public para Supabase
-- Execute no Supabase: SQL Editor > New query > Cole e rode

-- tenants
CREATE TABLE IF NOT EXISTS "public"."tenants" (
  "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
  "name" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "waToken" TEXT NOT NULL,
  "waPhoneNumberId" TEXT NOT NULL,
  "waWabaId" TEXT,
  "cwBaseUrl" TEXT NOT NULL DEFAULT 'https://integracao.cardapioweb.com',
  "cwApiKey" TEXT NOT NULL,
  "cwPartnerKey" TEXT NOT NULL,
  "cwStoreId" TEXT,
  "city" TEXT,
  "webhookToken" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_waPhoneNumberId_key" ON "public"."tenants"("waPhoneNumberId");

-- staff_users
CREATE TABLE IF NOT EXISTS "public"."staff_users" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "authUserId" TEXT NOT NULL,
  "tenantId" TEXT,
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "invitedBy" TEXT,
  "lastLoginAt" TIMESTAMPTZ(6),
  "canViewOrders" BOOLEAN NOT NULL DEFAULT true,
  "canSendMessages" BOOLEAN NOT NULL DEFAULT true,
  "canManageCoupons" BOOLEAN NOT NULL DEFAULT false,
  "canManageSettings" BOOLEAN NOT NULL DEFAULT false,
  "canManageUsers" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "staff_users_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "staff_users_authUserId_key" UNIQUE ("authUserId"),
  CONSTRAINT "staff_users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_staff_users_email" ON "public"."staff_users"("email");
CREATE INDEX IF NOT EXISTS "idx_staff_users_auth_user_id" ON "public"."staff_users"("authUserId");
CREATE INDEX IF NOT EXISTS "idx_staff_users_tenant" ON "public"."staff_users"("tenantId");
CREATE INDEX IF NOT EXISTS "idx_staff_users_role" ON "public"."staff_users"("role");
CREATE INDEX IF NOT EXISTS "idx_staff_users_active" ON "public"."staff_users"("active");
CREATE INDEX IF NOT EXISTS "idx_staff_users_tenant_active" ON "public"."staff_users"("tenantId", "active");

-- audit_logs
CREATE TABLE IF NOT EXISTS "public"."audit_logs" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT,
  "userId" TEXT,
  "action" TEXT NOT NULL,
  "resourceType" TEXT,
  "resourceId" TEXT,
  "metadata" TEXT,
  "ip" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_audit_logs_tenant_created" ON "public"."audit_logs"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "idx_audit_logs_user_created" ON "public"."audit_logs"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "idx_audit_logs_action_created" ON "public"."audit_logs"("action", "createdAt");

-- customers
CREATE TABLE IF NOT EXISTS "public"."customers" (
  "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
  "tenantId" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "name" TEXT,
  "lastAddress" TEXT,
  "lastStreet" TEXT,
  "lastNumber" TEXT,
  "lastNeighborhood" TEXT,
  "lastComplement" TEXT,
  "lastCity" TEXT,
  "lastLat" DOUBLE PRECISION,
  "lastLng" DOUBLE PRECISION,
  "handoff" BOOLEAN NOT NULL DEFAULT false,
  "handoffAt" TIMESTAMPTZ(6),
  "visitCount" INTEGER NOT NULL DEFAULT 0,
  "lastInteraction" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastOrderSummary" TEXT,
  "preferredPayment" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "queuedAt" TIMESTAMPTZ(6),
  "claimedBy" TEXT,
  CONSTRAINT "customers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "tenantId_phone" UNIQUE ("tenantId", "phone")
);
CREATE INDEX IF NOT EXISTS "idx_customers_tenantid" ON "public"."customers"("tenantId");

-- orders
CREATE TABLE IF NOT EXISTS "public"."orders" (
  "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
  "tenantId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'waiting_confirmation',
  "total" DOUBLE PRECISION NOT NULL,
  "deliveryFee" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "discount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "totalValidated" BOOLEAN NOT NULL DEFAULT false,
  "totalExpected" DOUBLE PRECISION,
  "fulfillment" TEXT NOT NULL,
  "paymentMethodId" TEXT,
  "paymentMethodName" TEXT,
  "itemsSnapshot" TEXT NOT NULL,
  "addressSnapshot" TEXT,
  "cwOrderId" TEXT,
  "cwPayload" TEXT,
  "cwResponse" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cardapiowebStatus" TEXT,
  "statusChangedAt" TIMESTAMPTZ(6),
  "timeInCurrentStatusMinutes" INTEGER,
  "dailyAvgProdToOutMinutes" DOUBLE PRECISION,
  "dailyAvgOutToDoneMinutes" DOUBLE PRECISION,
  "estimatedRemainingMin" INTEGER,
  "estimatedRemainingMax" INTEGER,
  "weatherDelayFactor" DOUBLE PRECISION,
  "delayAlertSentAt" TIMESTAMPTZ(6),
  "secondDelayAlertSentAt" TIMESTAMPTZ(6),
  "thirdDelayAlertSentAt" TIMESTAMPTZ(6),
  "attendantAlertSentAt" TIMESTAMPTZ(6),
  "watchedByAttendant" TEXT,
  "deliveryRiskLevel" TEXT,
  "compensationEligible" BOOLEAN DEFAULT false,
  "compensationReason" TEXT,
  "compensationType" TEXT,
  "couponCode" TEXT,
  "couponGeneratedAt" TIMESTAMPTZ(6),
  "couponSentAt" TIMESTAMPTZ(6),
  CONSTRAINT "orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "orders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."customers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "orders_cwOrderId_key" UNIQUE ("cwOrderId"),
  CONSTRAINT "tenantId_idempotencyKey" UNIQUE ("tenantId", "idempotencyKey")
);
CREATE INDEX IF NOT EXISTS "idx_orders_customerid" ON "public"."orders"("customerId");
CREATE INDEX IF NOT EXISTS "idx_orders_tenantid_status" ON "public"."orders"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "idx_orders_tenant_cw_status" ON "public"."orders"("tenantId", "cardapiowebStatus");

-- order_status_logs
CREATE TABLE IF NOT EXISTS "public"."order_status_logs" (
  "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
  "orderId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'system',
  "note" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_status_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "order_status_logs_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "idx_order_status_logs_orderid" ON "public"."order_status_logs"("orderId");

-- messages
CREATE TABLE IF NOT EXISTS "public"."messages" (
  "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
  "customerId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "sender" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "mediaUrl" TEXT,
  "mediaType" TEXT DEFAULT 'text',
  "waMessageId" TEXT,
  "status" TEXT DEFAULT 'sent',
  CONSTRAINT "messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "messages_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."customers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "messages_customer_created" ON "public"."messages"("customerId", "createdAt");
CREATE INDEX IF NOT EXISTS "idx_messages_wa_message_id" ON "public"."messages"("waMessageId");

-- configs
CREATE TABLE IF NOT EXISTS "public"."configs" (
  "id" SERIAL NOT NULL,
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  CONSTRAINT "configs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "configs_key_key" UNIQUE ("key")
);

-- retention_campaigns
CREATE TABLE IF NOT EXISTS "public"."retention_campaigns" (
  "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "delayHours" INTEGER NOT NULL DEFAULT 20,
  "monthlyLimit" INTEGER NOT NULL DEFAULT 100,
  "aiFilter" BOOLEAN NOT NULL DEFAULT true,
  "active" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "retention_campaigns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "retention_campaigns_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "idx_ret_campaigns_tenant_active" ON "public"."retention_campaigns"("tenantId", "active");

-- retention_sends
CREATE TABLE IF NOT EXISTS "public"."retention_sends" (
  "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
  "campaignId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "customerName" TEXT,
  "aiScore" TEXT,
  "sentAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "retention_sends_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "retention_sends_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "public"."retention_campaigns"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "idx_ret_sends_campaign_sent" ON "public"."retention_sends"("campaignId", "sentAt");
CREATE INDEX IF NOT EXISTS "idx_ret_sends_customer_sent" ON "public"."retention_sends"("customerId", "sentAt");
