// src/services/retention.service.js
// Sistema de retenção/reengajamento:
//   - Filtra clientes elegíveis (dentro da janela de 24h grátis da Meta)
//   - Usa IA (Gemini) para selecionar os melhores candidatos
//   - Controle de volume mensal para evitar gastos excessivos
//   - Agendador interno que roda a cada 30 minutos

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// ── Helpers ───────────────────────────────────────────────────

function startOfMonth() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function hoursAgo(h) {
  return new Date(Date.now() - h * 3600_000);
}

// ── Avaliação por IA ──────────────────────────────────────────
// Usa o mesmo Gemini que já audita as conversas para decidir o handoff.
// Retorna "sim", "talvez" ou "nao" + motivo (1 linha).
async function evaluateWithAI(customerName, lastOrderSummary, visitCount) {
  try {
    const ENV = require("../config/env");
    if (!ENV.GEMINI_API_KEY) return "talvez|GEMINI_API_KEY não configurado";

    const { GoogleGenerativeAI } = require("@google/generative-ai");
    const client = new GoogleGenerativeAI(ENV.GEMINI_API_KEY);
    const model  = client.getGenerativeModel({
      model: ENV.GEMINI_MODEL || "gemini-2.0-flash",
      generationConfig: { temperature: 0.1, maxOutputTokens: 80 },
    });

    const prompt = `Você avalia se vale enviar mensagem de retenção para cliente de restaurante.

Cliente:
- Nome: ${customerName || "desconhecido"}
- Pedidos anteriores: ${visitCount}
- Último pedido: ${lastOrderSummary || "nenhum"}

Responda em UMA linha: <score>|<motivo>
<score> deve ser: sim, talvez ou nao
Exemplo: sim|Cliente com 3 pedidos, retorno provável.`;

    const result = await model.generateContent(prompt);
    const line = result.response.text().trim().split("\n")[0];
    const [score, reason] = line.split("|");
    const s = (score || "talvez").toLowerCase().trim();
    const normalized = ["sim", "nao"].includes(s) ? s : "talvez";
    return `${normalized}|${(reason || "").trim()}`;
  } catch {
    return "talvez|erro na avaliação IA";
  }
}

// ── Busca candidatos elegíveis ────────────────────────────────
// Cliente é elegível se:
//   1. lastInteraction está entre delayHours e 24h atrás (janela grátis)
//   2. Não recebeu mensagem desta campanha este mês
async function findEligible(campaign) {
  const windowEnd   = hoursAgo(campaign.delayHours);  // mais antigo que delayHours
  const windowStart = hoursAgo(24);                    // mais recente que 24h (ainda na janela)

  // Clientes que já receberam esta campanha este mês
  const alreadySent = await prisma.retentionSend.findMany({
    where: { campaignId: campaign.id, sentAt: { gte: startOfMonth() } },
    select: { customerId: true },
  });
  const alreadySentIds = new Set(alreadySent.map(s => s.customerId));

  const customers = await prisma.customer.findMany({
    where: {
      tenantId: campaign.tenantId,
      lastInteraction: {
        gte: windowStart,
        lte: windowEnd,
      },
    },
    select: {
      id: true,
      phone: true,
      name: true,
      visitCount: true,
      lastOrderSummary: true,
    },
  });

  return customers.filter(c => !alreadySentIds.has(c.id));
}

// ── Conta envios do mês atual ─────────────────────────────────
async function monthlySendCount(campaignId) {
  return prisma.retentionSend.count({
    where: { campaignId, sentAt: { gte: startOfMonth() } },
  });
}

// ── Executa uma campanha ──────────────────────────────────────
async function runCampaign(campaign, wa) {
  const sentThisMonth = await monthlySendCount(campaign.id);
  const remaining = campaign.monthlyLimit - sentThisMonth;
  if (remaining <= 0) {
    console.log(`[Retention] Campanha "${campaign.name}" atingiu limite mensal (${campaign.monthlyLimit}).`);
    return { sent: 0, skipped: 0, reason: "limit_reached" };
  }

  const candidates = await findEligible(campaign);
  if (!candidates.length) {
    console.log(`[Retention] Campanha "${campaign.name}" — sem candidatos elegíveis.`);
    return { sent: 0, skipped: 0, reason: "no_candidates" };
  }

  let sent = 0;
  let skipped = 0;

  for (const customer of candidates) {
    if (sent >= remaining) break;

    let aiScore = null;
    if (campaign.aiFilter) {
      aiScore = await evaluateWithAI(customer.name, customer.lastOrderSummary, customer.visitCount);
      const decision = aiScore.split("|")[0];
      if (decision === "nao") {
        console.log(`[Retention] IA rejeitou ${customer.phone}: ${aiScore}`);
        skipped++;
        continue;
      }
    }

    // Personaliza a mensagem
    const firstName = customer.name ? customer.name.split(" ")[0] : "";
    const text = campaign.message.replace(/\{nome\}/gi, firstName).replace(/\{name\}/gi, firstName);

    try {
      await wa.sendText(customer.phone, text);

      await prisma.retentionSend.create({
        data: {
          campaignId: campaign.id,
          customerId: customer.id,
          phone: customer.phone,
          customerName: customer.name,
          aiScore,
        },
      });

      sent++;
      console.log(`[Retention] Enviado para ${customer.phone} (${aiScore || "sem IA"})`);

      // Pequena pausa para não sobrecarregar a API
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.warn(`[Retention] Falha ao enviar para ${customer.phone}:`, err.message);
    }
  }

  return { sent, skipped };
}

// ── Executa todas as campanhas ativas ─────────────────────────
async function runAll() {
  try {
    const campaigns = await prisma.retentionCampaign.findMany({
      where: { active: true },
    });

    if (!campaigns.length) return;

    const { getClients } = require("./tenant.service");

    for (const campaign of campaigns) {
      try {
        const { wa } = await getClients(campaign.tenantId);
        const result = await runCampaign(campaign, wa);
        console.log(`[Retention] "${campaign.name}" — enviados: ${result.sent}, ignorados: ${result.skipped}`);
      } catch (err) {
        console.error(`[Retention] Erro na campanha "${campaign.name}":`, err.message);
      }
    }
  } catch (err) {
    console.error("[Retention] Erro geral:", err.message);
  }
}

// ── Estatísticas mensais ──────────────────────────────────────
async function getMonthlyStats(tenantId) {
  const start = startOfMonth();

  // Envios por dia (join via campaign)
  const sends = await prisma.retentionSend.findMany({
    where: {
      campaign: { tenantId },
      sentAt: { gte: start },
    },
    select: { sentAt: true, campaignId: true },
    orderBy: { sentAt: "asc" },
  });

  // Agrupa por dia
  const byDay = {};
  for (const s of sends) {
    const day = s.sentAt.toISOString().slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
  }

  // Total do mês por campanha
  const byCampaign = {};
  for (const s of sends) {
    byCampaign[s.campaignId] = (byCampaign[s.campaignId] || 0) + 1;
  }

  return {
    totalMonth: sends.length,
    byDay,
    byCampaign,
  };
}

// ── Agendador: roda a cada 30 minutos ─────────────────────────
let schedulerRunning = false;
function startScheduler() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  console.log("[Retention] Agendador iniciado (intervalo: 30 min)");
  setInterval(runAll, 30 * 60 * 1000);
  // Primeira execução após 2 min (espera o boot)
  setTimeout(runAll, 2 * 60 * 1000);
}

module.exports = { runAll, runCampaign, getMonthlyStats, startScheduler, evaluateWithAI };
