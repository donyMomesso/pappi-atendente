#!/usr/bin/env node
// Adiciona um e-mail à lista de usuários autorizados (Login Google).
// Uso: node scripts/add-google-user.js email@exemplo.com [tenant-id]
// Ex:  node scripts/add-google-user.js pappipizza18@gmail.com

require("dotenv").config();
const prisma = require("../src/lib/db");

const email = process.argv[2]?.trim()?.toLowerCase();
const tenantId = process.argv[3] || "tenant-pappi-001";

if (!email || !email.includes("@")) {
  console.error("Uso: node scripts/add-google-user.js email@exemplo.com [tenant-id]");
  process.exit(1);
}

async function main() {
  const cfg = await prisma.config.findUnique({ where: { key: `${tenantId}:google_users` } });
  const users = cfg ? JSON.parse(cfg.value) : [];

  if (users.some((u) => u.email === email)) {
    console.log(`✅ E-mail ${email} já está autorizado.`);
    return;
  }

  users.push({ email, role: "attendant" });
  await prisma.config.upsert({
    where: { key: `${tenantId}:google_users` },
    create: { key: `${tenantId}:google_users`, value: JSON.stringify(users) },
    update: { value: JSON.stringify(users) },
  });
  console.log(`✅ E-mail ${email} adicionado ao tenant ${tenantId}.`);
}

main()
  .catch((e) => {
    console.error("Erro:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
