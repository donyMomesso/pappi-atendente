-- staff_users: perfil e relação (somente novas colunas; renomeação de FK é só no Prisma)
ALTER TABLE "public"."staff_users" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "public"."staff_users" ADD COLUMN IF NOT EXISTS "department" TEXT;

CREATE TABLE IF NOT EXISTS "public"."staff_user_invites" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "email" TEXT NOT NULL,
    "tenantId" TEXT,
    "role" TEXT NOT NULL,
    "department" TEXT,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "invitedBy" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "staff_user_invites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "staff_user_invites_token_key" ON "public"."staff_user_invites"("token");

CREATE INDEX IF NOT EXISTS "idx_staff_user_invites_email" ON "public"."staff_user_invites"("email");

DO $$ BEGIN
  ALTER TABLE "public"."staff_user_invites" ADD CONSTRAINT "staff_user_invites_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "public"."tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
