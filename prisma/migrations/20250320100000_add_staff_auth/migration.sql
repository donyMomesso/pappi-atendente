-- Staff users e audit log para autenticação corporativa

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

CREATE INDEX IF NOT EXISTS "idx_staff_users_email" ON "public"."staff_users"("email");
CREATE INDEX IF NOT EXISTS "idx_staff_users_auth_user_id" ON "public"."staff_users"("authUserId");
CREATE INDEX IF NOT EXISTS "idx_staff_users_tenant" ON "public"."staff_users"("tenantId");
CREATE INDEX IF NOT EXISTS "idx_staff_users_role" ON "public"."staff_users"("role");
CREATE INDEX IF NOT EXISTS "idx_staff_users_active" ON "public"."staff_users"("active");
CREATE INDEX IF NOT EXISTS "idx_staff_users_tenant_active" ON "public"."staff_users"("tenantId", "active");
CREATE INDEX IF NOT EXISTS "idx_audit_logs_tenant_created" ON "public"."audit_logs"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "idx_audit_logs_user_created" ON "public"."audit_logs"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "idx_audit_logs_action_created" ON "public"."audit_logs"("action", "createdAt");
