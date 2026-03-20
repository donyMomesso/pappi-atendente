// src/services/retention.service.js
// CORREÇÃO: usa singleton do PrismaClient

const prisma = require("../lib/db");

function startOfMonth() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function hoursAgo(h) {
  return new Date(Date.now() - h * 3600_000);
}

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
    const line   = result.response.text().trim().split("\n")[0];
    const [score, reason] = line.split("|");
    const s          = (score || "talvez").toLowerCase().trim();
    const normalized = ["sim", "nao"].includes(s) ? s : "talvez";
    return `${normalized}|${(reason || "").trim()}`;
  } catch {
    return "talvez|erro na avaliação IA";
  }
}

async function findEligible(campaign) {
  const windowEnd   = hoursAgo(campaign.delayHours);
  const windowStart = hoursAgo(24);

  const alreadySent = await prisma.retentionSend.findMany({
    where:  { campaignId: campaign.id, sentAt: { gte: startOfMonth() } },
    select: { customerId: true },
  });
  const alreadySentIds = new Set(alreadySent.map(s => s.customerId));

  const customers = await prisma.customer.findMany({
    where: {
      tenantId:        campaign.tenantId,
      lastInteraction: { gte: windowStart, lte: windowEnd },
    },
    select: { id: true, phone: true, name: true, visitCount: true, lastOrderSummary: true },
  });

  return customers.filter(c => !alreadySentIds.has(c.id));
}

async function monthlySendCount(campaignId) {
  return prisma.retentionSend.count({
    where: { campaignId, sentAt: { gte: startOfMonth() } },
  });
}

async function runCampaign(campaign, wa) {
  const sentThisMonth = await monthlySendCount(campaign.id);
  const remaining     = campaign.monthlyLimit - sentThisMonth;
  if (remaining <= 0) {
    console.log(`[Retention] Campanha "${campaign.name}" atingiu limite mensal.`);
    return { sent: 0, skipped: 0, reason: "limit_reached" };
  }

  const candidates = await findEligible(campaign);
  if (!candidates.length) {
    console.log(`[Retention] Campanha "${campaign.name}" — sem candidatos elegíveis.`);
    return { sent: 0, skipped: 0, reason: "no_candidates" };
  }

  let sent = 0, skipped = 0;

  for (const customer of candidates) {
    if (sent >= remaining) break;

    let aiScore = null;
    if (campaign.aiFilter) {
      aiScore = await evaluateWithAI(customer.name, customer.lastOrderSummary, customer.visitCount);
      const decision = aiScore.split("|")[0];
      if (decision === "nao") { skipped++; continue; }
    }

    const firstName = customer.name ? customer.name.split(" ")[0] : "";
    const text      = campaign.message
      .replace(/\{nome\}/gi, firstName)
      .replace(/\{name\}/gi, firstName)
      .replace(/\{ultimo_pedido\}/gi, customer.lastOrderSummary || "")
      .replace(/\{dias_ausente\}/gi, String(Math.floor((Date.now() - new Date(customer.lastInteraction || Date.now()).getTime()) / 86_400_000)));

    try {
      await wa.sendText(customer.phone, text);
      await prisma.retentionSend.create({
        data: { campaignId: campaign.id, customerId: customer.id, phone: customer.phone, customerName: customer.name, aiScore },
      });
      sent++;
      console.log(`[Retention] Enviado para ${customer.phone} (${aiScore || "sem IA"})`);
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.warn(`[Retention] Falha ao enviar para ${customer.phone}:`, err.message);
    }
  }

  return { sent, skipped };
}

async function runAll() {
  try {
    const campaigns = await prisma.retentionCampaign.findMany({ where: { active: true } });
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

async function getMonthlyStats(tenantId) {
  const start = startOfMonth();
  const sends = await prisma.retentionSend.findMany({
    where:   { campaign: { tenantId }, sentAt: { gte: start } },
    select:  { sentAt: true, campaignId: true },
    orderBy: { sentAt: "asc" },
  });

  const byDay = {}, byCampaign = {};
  for (const s of sends) {
    const day = s.sentAt.toISOString().slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
    byCampaign[s.campaignId] = (byCampaign[s.campaignId] || 0) + 1;
  }

  return { totalMonth: sends.length, byDay, byCampaign };
}

let schedulerRunning = false;
function startScheduler() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  console.log("[Retention] Agendador iniciado (intervalo: 30 min)");
  setInterval(runAll, 30 * 60 * 1000);
  setTimeout(runAll, 2 * 60 * 1000);
}

module.exports = { runAll, runCampaign, getMonthlyStats, startScheduler, evaluateWithAI };
