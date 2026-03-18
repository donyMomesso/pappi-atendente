// check-wa-status.js
// Script para diagnosticar o status da conexão do WhatsApp Interno (Baileys) no banco de dados.

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function checkStatus() {
  console.log("🔍 Iniciando diagnóstico do WhatsApp Interno...\n");

  try {
    // 1. Verificar se existe registro de autenticação no banco
    const authRow = await prisma.config.findUnique({ where: { key: "baileys:auth" } });
    
    if (!authRow) {
      console.log("❌ STATUS: Desconectado");
      console.log("👉 Motivo: Não foram encontradas credenciais de autenticação no banco de dados (tabela 'configs').");
      console.log("💡 Solução: Você precisa acessar o painel administrativo e escanear o QR Code novamente.");
    } else {
      try {
        const authData = JSON.parse(authRow.value);
        const creds = authData.creds;
        
        if (creds && creds.me) {
          console.log("✅ STATUS: Conectado");
          console.log(`📱 Conta: ${creds.me.name || 'Sem nome'} (${creds.me.id.split(':')[0]})`);
          console.log(`📅 Última atualização: ${new Date(authRow.updatedAt || Date.now()).toLocaleString('pt-BR')}`);
        } else {
          console.log("⚠️ STATUS: Sessão Expirada ou Inválida");
          console.log("👉 Motivo: O registro existe, mas os dados da conta conectada estão ausentes ou corrompidos.");
          console.log("💡 Solução: Desconecte e conecte novamente pelo painel.");
        }
      } catch (e) {
        console.log("❌ STATUS: Erro de Dados");
        console.log("👉 Motivo: Falha ao ler as credenciais salvas no banco.");
      }
    }

    // 2. Verificar números de notificação configurados
    const notifyConfig = await prisma.config.findUnique({ where: { key: "baileys:notify_numbers" } });
    console.log("\n--- Configurações de Notificação ---");
    if (notifyConfig) {
      const numbers = JSON.parse(notifyConfig.value);
      console.log(`📞 Números que recebem alertas: ${numbers.length > 0 ? numbers.join(", ") : "Nenhum cadastrado"}`);
    } else {
      console.log("⚠️ Nenhum número configurado para receber notificações internas.");
    }

  } catch (err) {
    console.error("\n🔥 Erro ao conectar ao banco de dados:", err.message);
    console.log("👉 Verifique se a sua DATABASE_URL no arquivo .env está correta.");
  } finally {
    await prisma.$disconnect();
  }
}

checkStatus();
