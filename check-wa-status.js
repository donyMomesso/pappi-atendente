// check-wa-status.js
// Script de diagnóstico do WhatsApp Interno (Baileys)
// Uso: node check-wa-status.js
// Considera APP_ENV para chaves baileys:auth:{env}:{instanceId}

require("dotenv").config();
const prisma = require("./src/lib/db");
const ENV = require("./src/config/env");

function authKey(instanceId) {
  const env = ENV.APP_ENV || "local";
  return `baileys:auth:${env}:${instanceId}`;
}

async function checkStatus() {
  const env = ENV.APP_ENV || "local";
  console.log(`🔍 Diagnóstico WhatsApp Interno (APP_ENV=${env})...\n`);

  try {
    const authRow = await prisma.config.findUnique({ where: { key: authKey("default") } });

    if (!authRow) {
      console.log("❌ STATUS: Desconectado");
      console.log("👉 Motivo: Não foram encontradas credenciais de autenticação no banco.");
      console.log("💡 Solução: Acesse o painel e escaneie o QR Code em Configurações > WhatsApp Interno.");
    } else {
      try {
        const { BufferJSON } = require("@whiskeysockets/baileys");
        const authData = JSON.parse(authRow.value, BufferJSON.reviver);
        const creds = authData.creds;

        if (creds && creds.me) {
          console.log("✅ STATUS: Conectado");
          console.log(`📱 Conta: ${creds.me.name || "Sem nome"} (${creds.me.id.split(":")[0]})`);
          console.log(`📅 Última atualização: ${new Date(authRow.updatedAt || Date.now()).toLocaleString("pt-BR")}`);
        } else {
          console.log("⚠️  STATUS: Sessão Expirada ou Inválida");
          console.log("💡 Solução: Desconecte e reconecte pelo painel.");
        }
      } catch (e) {
        console.log("❌ STATUS: Erro ao ler credenciais —", e.message);
      }
    }

    // Instâncias existentes (apenas do ambiente atual)
    const prefix = `baileys:auth:${env}:`;
    const allInstances = await prisma.config.findMany({
      where: { key: { startsWith: prefix } },
      select: { key: true },
    });
    console.log(`\n📊 Instâncias cadastradas (${env}): ${allInstances.length}`);
    for (const i of allInstances) {
      console.log(`   - ${i.key.replace(prefix, "")}`);
    }

    // Números de notificação
    const notifyConfig = await prisma.config.findUnique({ where: { key: "baileys:notify_numbers" } });
    console.log("\n--- Configurações de Notificação ---");
    if (notifyConfig) {
      const numbers = JSON.parse(notifyConfig.value);
      console.log(`📞 Números que recebem alertas: ${numbers.length > 0 ? numbers.join(", ") : "Nenhum cadastrado"}`);
    } else {
      console.log("⚠️  Nenhum número configurado para notificações internas.");
    }

    // Pedidos com falha no CW
    const cwFailed = await prisma.order.count({ where: { status: "cw_failed" } });
    if (cwFailed > 0) {
      console.log(`\n🚨 ATENÇÃO: ${cwFailed} pedido(s) com falha definitiva no CardápioWeb!`);
      console.log("   Acesse /admin/cw-failed para ver os detalhes.");
    }
  } catch (err) {
    console.error("\n🔥 Erro ao conectar ao banco de dados:", err.message);
    console.log("👉 Verifique se DATABASE_URL está correto no .env");
  } finally {
    await prisma.$disconnect();
  }
}

checkStatus();
