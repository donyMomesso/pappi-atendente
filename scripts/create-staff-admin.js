#!/usr/bin/env node
// Cria primeiro usuário admin em staff_users.
// Uso: node scripts/create-staff-admin.js email@empresa.com SenhaSegura123 [tenant-id]
// Requer: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY no .env

require("dotenv").config();
const prisma = require("../src/lib/db");
const supabaseAuth = require("../src/services/supabase-auth.service");

const email = process.argv[2]?.trim()?.toLowerCase();
const password = process.argv[3];
const tenantId = process.argv[4] || null;

if (!email || !password || password.length < 6) {
  console.error("Uso: node scripts/create-staff-admin.js email@empresa.com SenhaSegura123 [tenant-id]");
  process.exit(1);
}

async function main() {
  const existing = await prisma.staff_users.findFirst({ where: { email } });
  if (existing) {
    console.log("✅ E-mail já existe em staff_users. Use o painel para resetar senha.");
    return;
  }

  const authUser = await supabaseAuth.createAuthUser({ email, password, emailConfirm: true });
  await prisma.staff_users.create({
    data: {
      authUserId: authUser.id,
      email,
      name: email.split("@")[0],
      role: "admin",
      tenantId,
      active: true,
      canViewOrders: true,
      canSendMessages: true,
      canManageCoupons: true,
      canManageSettings: true,
      canManageUsers: true,
    },
  });
  console.log(`✅ Admin criado: ${email}`);
  console.log("   Faça login no painel com este e-mail e senha.");
}

main()
  .catch((e) => {
    console.error("Erro:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
