#!/usr/bin/env node
// scripts/create-first-admin.js
// Cria o primeiro usuário admin (Supabase Auth + StaffUser).
// Uso: ADMIN_EMAIL=admin@empresa.com ADMIN_PASSWORD=senha123 ADMIN_NAME="Admin" node scripts/create-first-admin.js

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const prisma = require("../src/lib/db");

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || process.argv[2];
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.argv[3];
const ADMIN_NAME = process.env.ADMIN_NAME || process.argv[4] || "Admin";

async function main() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error("Uso: ADMIN_EMAIL=... ADMIN_PASSWORD=... [ADMIN_NAME=...] node scripts/create-first-admin.js");
    console.error("Ou: node scripts/create-first-admin.js email@empresa.com senha123 'Nome Admin'");
    process.exit(1);
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env");
    process.exit(1);
  }

  const emailNorm = ADMIN_EMAIL.trim().toLowerCase();
  const existing = await prisma.staffUser.findFirst({ where: { email: emailNorm } });
  if (existing) {
    console.log("Admin já existe:", emailNorm);
    process.exit(0);
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
    email: emailNorm,
    password: ADMIN_PASSWORD,
    email_confirm: true,
  });

  if (authErr) {
    console.error("Erro ao criar no Supabase:", authErr.message);
    process.exit(1);
  }

  await prisma.staffUser.create({
    data: {
      authUserId: authData.user.id,
      email: emailNorm,
      name: ADMIN_NAME.trim(),
      role: "admin",
      tenantId: null,
      active: true,
      canViewOrders: true,
      canSendMessages: true,
      canManageCoupons: true,
      canManageSettings: true,
      canManageUsers: true,
    },
  });

  console.log("✅ Admin criado:", emailNorm);
  console.log("   Faça login em", process.env.APP_URL || "https://app.pappiatendente.com.br");
}

main()
  .catch((e) => {
    console.error("Erro:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
