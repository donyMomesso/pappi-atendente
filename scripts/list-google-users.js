#!/usr/bin/env node
require("dotenv").config();
const prisma = require("../src/lib/db");

async function main() {
  const cfgs = await prisma.config.findMany({ where: { key: { contains: "google_users" } } });
  for (const c of cfgs) {
    const users = JSON.parse(c.value || "[]");
    console.log(c.key, "=>", users.map(u => u.email).join(", ") || "(vazio)");
  }
}

main().finally(() => prisma.$disconnect());
