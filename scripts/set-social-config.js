#!/usr/bin/env node
// Uso: node scripts/set-social-config.js
// Configure as variáveis abaixo antes de rodar.

require("dotenv").config();
const prisma = require("../src/lib/db");

const TENANT_ID = "tenant-pappi-001";
const INSTAGRAM_PAGE_TOKEN = process.env.INSTAGRAM_PAGE_TOKEN || "";
const FACEBOOK_PAGE_TOKEN = process.env.FACEBOOK_PAGE_TOKEN || "COLE_SEU_TOKEN_AQUI";
const INSTAGRAM_PAGE_ID = process.env.INSTAGRAM_PAGE_ID || ""; // Ex: 17841400000000000
const FACEBOOK_PAGE_ID = process.env.FACEBOOK_PAGE_ID || ""; // Ex: 123456789

async function main() {
  if (!INSTAGRAM_PAGE_TOKEN && (!FACEBOOK_PAGE_TOKEN || FACEBOOK_PAGE_TOKEN === "COLE_SEU_TOKEN_AQUI")) {
    console.error("❌ Configure INSTAGRAM_PAGE_TOKEN e/ou FACEBOOK_PAGE_TOKEN no .env.");
    process.exit(1);
  }

  if (INSTAGRAM_PAGE_TOKEN) {
    await prisma.config.upsert({
      where: { key: `${TENANT_ID}:instagram_page_token` },
      create: { key: `${TENANT_ID}:instagram_page_token`, value: INSTAGRAM_PAGE_TOKEN.trim() },
      update: { value: INSTAGRAM_PAGE_TOKEN.trim() },
    });
    console.log("✅ instagram_page_token configurado");
  }

  if (FACEBOOK_PAGE_TOKEN && FACEBOOK_PAGE_TOKEN !== "COLE_SEU_TOKEN_AQUI") {
    await prisma.config.upsert({
      where: { key: `${TENANT_ID}:facebook_page_token` },
      create: { key: `${TENANT_ID}:facebook_page_token`, value: FACEBOOK_PAGE_TOKEN.trim() },
      update: { value: FACEBOOK_PAGE_TOKEN.trim() },
    });
    console.log("✅ facebook_page_token configurado");
  }

  if (INSTAGRAM_PAGE_ID) {
    await prisma.config.upsert({
      where: { key: `${TENANT_ID}:instagram_page_id` },
      create: { key: `${TENANT_ID}:instagram_page_id`, value: String(INSTAGRAM_PAGE_ID).trim() },
      update: { value: String(INSTAGRAM_PAGE_ID).trim() },
    });
    console.log("✅ instagram_page_id configurado");
  }

  if (FACEBOOK_PAGE_ID) {
    await prisma.config.upsert({
      where: { key: `${TENANT_ID}:facebook_page_id` },
      create: { key: `${TENANT_ID}:facebook_page_id`, value: String(FACEBOOK_PAGE_ID).trim() },
      update: { value: String(FACEBOOK_PAGE_ID).trim() },
    });
    console.log("✅ facebook_page_id configurado");
  }

  console.log("\n🎉 Pronto! Reinicie o servidor se estiver rodando.");
}

main()
  .catch((e) => {
    console.error("❌ Erro:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
