// src/services/bot-learning.service.js
// Sistema de aprendizado do bot baseado em conversas reais.
// Armazena padrões na tabela Config (key: learn:{tenantId}:*) sem necessidade de migration.
//
// O bot aprende de 3 formas:
// 1. FAQ: perguntas frequentes que o bot não soube responder → humano respondeu
// 2. Correções: quando o atendente corrige uma resposta do bot
// 3. Preferências: padrões de pedido por cliente (sabores, horários, pagamento)

const prisma = require("../lib/db");
const messageDbCompat = require("../lib/message-db-compat");

const KEYS = {
  faq: (tenantId) => `learn:${tenantId}:faq`,
  corrections: (tenantId) => `learn:${tenantId}:corrections`,
  patterns: (tenantId) => `learn:${tenantId}:patterns`,
  complaints: (tenantId) => `learn:${tenantId}:complaints`,
};

const MAX_FAQ = 50;
const MAX_CORRECTIONS = 30;
const MAX_PATTERNS = 50;

// ── Cache em memória com TTL ──────────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function _load(key) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.data;

  try {
    const row = await prisma.config.findUnique({ where: { key } });
    const data = row?.value ? JSON.parse(row.value) : [];
    cache.set(key, { data, at: Date.now() });
    return data;
  } catch {
    return [];
  }
}

async function _save(key, data) {
  cache.set(key, { data, at: Date.now() });
  await prisma.config
    .upsert({
      where: { key },
      create: { key, value: JSON.stringify(data) },
      update: { value: JSON.stringify(data) },
    })
    .catch((err) => console.error("[Learning] Erro ao salvar:", err.message));
}

// ── 1. FAQ: aprende com handoffs ──────────────────────────────
// Quando um cliente é transferido para humano, o bot "não soube" responder.
// Depois, o humano responde. O sistema captura pergunta→resposta como FAQ.

async function learnFromHandoff(tenantId, customerQuestion, humanAnswer) {
  if (!customerQuestion?.trim() || !humanAnswer?.trim()) return;
  if (customerQuestion.length < 5 || humanAnswer.length < 5) return;

  const faq = await _load(KEYS.faq(tenantId));
  const q = customerQuestion.trim().toLowerCase().slice(0, 200);

  const existing = faq.find((f) => f.q === q);
  if (existing) {
    existing.a = humanAnswer.trim().slice(0, 500);
    existing.count = (existing.count || 1) + 1;
    existing.updatedAt = new Date().toISOString();
  } else {
    faq.push({
      q,
      a: humanAnswer.trim().slice(0, 500),
      count: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  if (faq.length > MAX_FAQ) faq.splice(0, faq.length - MAX_FAQ);
  await _save(KEYS.faq(tenantId), faq);
}

// ── 2. Correções: quando o atendente corrige o bot ────────────
// Se o bot deu uma resposta e logo depois o humano enviou outra
// (diferente), o sistema captura como correção.

async function learnFromCorrection(tenantId, botReply, humanCorrection, context = "") {
  if (!botReply?.trim() || !humanCorrection?.trim()) return;

  const corrections = await _load(KEYS.corrections(tenantId));

  corrections.push({
    bot: botReply.trim().slice(0, 300),
    human: humanCorrection.trim().slice(0, 500),
    context: context.slice(0, 200),
    createdAt: new Date().toISOString(),
  });

  if (corrections.length > MAX_CORRECTIONS) corrections.splice(0, corrections.length - MAX_CORRECTIONS);
  await _save(KEYS.corrections(tenantId), corrections);
}

// ── 3. Padrões: preferências de clientes ──────────────────────
// Detecta padrões recorrentes: sabores favoritos, horário habitual,
// forma de pagamento preferida, frequência de pedidos.

async function learnCustomerPattern(tenantId, phone, pattern) {
  if (!phone || !pattern) return;

  const patterns = await _load(KEYS.patterns(tenantId));
  const existing = patterns.find((p) => p.phone === phone);

  if (existing) {
    if (pattern.favoriteItems) existing.favoriteItems = _mergeItems(existing.favoriteItems, pattern.favoriteItems);
    if (pattern.paymentMethod) existing.paymentMethod = pattern.paymentMethod;
    if (pattern.fulfillment) existing.fulfillment = pattern.fulfillment;
    if (pattern.orderHour != null) {
      existing.orderHours = existing.orderHours || [];
      existing.orderHours.push(pattern.orderHour);
      if (existing.orderHours.length > 20) existing.orderHours = existing.orderHours.slice(-20);
    }
    existing.orderCount = (existing.orderCount || 0) + 1;
    existing.updatedAt = new Date().toISOString();
  } else {
    patterns.push({
      phone,
      favoriteItems: pattern.favoriteItems || [],
      paymentMethod: pattern.paymentMethod || null,
      fulfillment: pattern.fulfillment || null,
      orderHours: pattern.orderHour != null ? [pattern.orderHour] : [],
      orderCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  if (patterns.length > MAX_PATTERNS) patterns.splice(0, patterns.length - MAX_PATTERNS);
  await _save(KEYS.patterns(tenantId), patterns);
}

function _mergeItems(existing = [], newItems = []) {
  const map = new Map();
  for (const item of existing) map.set(item.name, (map.get(item.name) || 0) + (item.count || 1));
  for (const item of newItems) map.set(item.name, (map.get(item.name) || 0) + 1);
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

// ── Gerar contexto de aprendizado para o prompt ───────────────
// Retorna texto formatado para injetar no prompt do chatOrder,
// dando ao bot contexto sobre o que ele aprendeu.

async function getLearningContext(tenantId, phone) {
  const parts = [];

  // FAQ relevante (top 10 mais usadas)
  const faq = await _load(KEYS.faq(tenantId));
  if (faq.length > 0) {
    const topFaq = faq.sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 10);
    parts.push(
      "RESPOSTAS APRENDIDAS (use quando o cliente perguntar algo parecido):\n" +
        topFaq.map((f) => `  P: "${f.q}" → R: "${f.a}"`).join("\n"),
    );
  }

  // Correções recentes (top 5)
  const corrections = await _load(KEYS.corrections(tenantId));
  if (corrections.length > 0) {
    const recent = corrections.slice(-5);
    parts.push(
      "CORREÇÕES (evite repetir estes erros):\n" + recent.map((c) => `  ❌ "${c.bot}" → ✅ "${c.human}"`).join("\n"),
    );
  }

  // Preferências do cliente atual
  if (phone) {
    const patterns = await _load(KEYS.patterns(tenantId));
    const p = patterns.find((pp) => pp.phone === phone);
    if (p && p.orderCount > 0) {
      const favs = (p.favoriteItems || [])
        .slice(0, 3)
        .map((i) => i.name)
        .join(", ");
      const info = [];
      if (favs) info.push(`Favoritos: ${favs}`);
      if (p.paymentMethod) info.push(`Pagamento habitual: ${p.paymentMethod}`);
      if (p.fulfillment) info.push(`Prefere: ${p.fulfillment}`);
      info.push(`${p.orderCount} pedidos anteriores`);
      parts.push(`PERFIL DO CLIENTE (use para personalizar):\n  ${info.join(" | ")}`);
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : "";
}

// ── 4. Reclamações: detectadas por sentimento ─────────────────
const MAX_COMPLAINTS = 50;

async function recordComplaint(tenantId, phone, customerName, text, tags) {
  if (!text?.trim()) return;

  const complaints = await _load(KEYS.complaints(tenantId));

  complaints.push({
    phone,
    name: customerName || phone,
    text: text.trim().slice(0, 300),
    tags,
    resolved: false,
    createdAt: new Date().toISOString(),
  });

  if (complaints.length > MAX_COMPLAINTS) complaints.splice(0, complaints.length - MAX_COMPLAINTS);
  await _save(KEYS.complaints(tenantId), complaints);
}

async function resolveComplaint(tenantId, index) {
  const complaints = await _load(KEYS.complaints(tenantId));
  if (index >= 0 && index < complaints.length) {
    complaints[index].resolved = true;
    complaints[index].resolvedAt = new Date().toISOString();
    await _save(KEYS.complaints(tenantId), complaints);
  }
}

// ── Análise automática em tempo real ──────────────────────────
// Chamado a cada mensagem do cliente para detectar sentimento.

async function analyzeMessage(tenantId, phone, customerName, text) {
  try {
    const sentiment = require("./sentiment.service");
    const result = sentiment.analyze(text);

    if (result.isComplaint) {
      await recordComplaint(tenantId, phone, customerName, text, result.tags);

      // Alerta em tempo real
      try {
        const socketService = require("./socket.service");
        socketService.emitAlert({
          type: "complaint",
          phone,
          name: customerName || phone,
          text: text.slice(0, 100),
          tags: result.tags,
          score: result.score,
          at: new Date().toISOString(),
        });
      } catch {}

      try {
        const baileys = require("./baileys.service");
        baileys
          .notify(
            `🚨 *Reclamação detectada!*\n👤 ${customerName || phone}\n📞 ${phone}\n💬 "${text.slice(0, 80)}"\n🏷️ ${result.tags.join(", ")}`,
          )
          .catch(() => {});
      } catch {}

      console.log(`[Sentiment] ⚠️ Reclamação detectada: ${phone} — "${text.slice(0, 60)}" [${result.tags.join(",")}]`);
    }

    return result;
  } catch (err) {
    console.error("[Learning] analyzeMessage:", err.message);
    return null;
  }
}

// ── Análise automática de conversas para aprendizado ──────────
// Chamado periodicamente ou no fim de cada conversa.

async function analyzeConversation(tenantId, customerId, _phone) {
  try {
    const chatMemory = require("./chat-memory.service");
    const messages = await chatMemory.get(customerId);
    if (!messages || messages.length < 4) return;

    const recent = messages.slice(-30);

    // Detecta handoff seguido de resposta humana
    for (let i = 0; i < recent.length - 1; i++) {
      const msg = recent[i];
      const next = recent[i + 1];

      if (msg.role === "customer" && (next.role === "attendant" || next.role === "human")) {
        await learnFromHandoff(tenantId, msg.text, next.text);
      }

      if (
        msg.role === "assistant" &&
        (next.role === "attendant" || next.role === "human") &&
        i > 0 &&
        recent[i - 1]?.role === "customer"
      ) {
        await learnFromCorrection(tenantId, msg.text, next.text, recent[i - 1].text);
      }
    }
  } catch (err) {
    console.error("[Learning] analyzeConversation:", err.message);
  }
}

// ── CRUD para admin ───────────────────────────────────────────

async function getAll(tenantId) {
  const [faq, corrections, patterns, complaints] = await Promise.all([
    _load(KEYS.faq(tenantId)),
    _load(KEYS.corrections(tenantId)),
    _load(KEYS.patterns(tenantId)),
    _load(KEYS.complaints(tenantId)),
  ]);

  const sortedFaq = faq.sort((a, b) => (b.count || 0) - (a.count || 0));
  const sortedPatterns = patterns.sort((a, b) => (b.orderCount || 0) - (a.orderCount || 0));
  const sortedComplaints = complaints.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const now = new Date();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const since72h = new Date(now.getTime() - 72 * 60 * 60 * 1000);
  const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  let recentCustomers = [];
  let openWindowCustomers = 0;
  let handoffCustomers = 0;
  let recentOrders = [];
  let cwFailedCount7d = 0;
  let delayedOrders = 0;
  let recentInboundByCustomer = new Map();

  try {
    [recentCustomers, openWindowCustomers, handoffCustomers, recentOrders, cwFailedCount7d, delayedOrders] = await Promise.all([
      prisma.customer.findMany({
        where: {
          tenantId,
          OR: [{ lastInteraction: { gte: since72h } }, { handoff: true }],
        },
        orderBy: { lastInteraction: 'desc' },
        take: 80,
        select: { id: true, name: true, phone: true, lastInteraction: true, handoff: true, claimedBy: true },
      }),
      prisma.customer.count({ where: { tenantId, lastInteraction: { gte: since24h } } }),
      prisma.customer.count({ where: { tenantId, handoff: true } }),
      prisma.order.findMany({
        where: { tenantId, createdAt: { gte: since7d } },
        orderBy: { createdAt: 'desc' },
        take: 120,
        select: {
          id: true,
          customerId: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          totalPrice: true,
          deliveryRiskLevel: true,
          observation: true,
          customer: { select: { name: true, phone: true } },
        },
      }),
      prisma.order.count({ where: { tenantId, createdAt: { gte: since7d }, status: 'cw_failed' } }),
      prisma.order.count({ where: { tenantId, deliveryRiskLevel: { in: ['alto', 'critico', 'prioridade_maxima'] }, status: { notIn: ['cancelled', 'concluded', 'delivered'] } } }),
    ]);
  } catch (err) {
    console.error('[Learning] getAll/db:', err.message);
  }

  if (messageDbCompat.isMessagesTableAvailable()) {
    try {
      const inbound = await prisma.message.findMany({
        where: {
          createdAt: { gte: since24h },
          customer: { tenantId },
          role: { in: ['customer', 'user'] },
        },
        orderBy: { createdAt: 'desc' },
        select: { customerId: true, text: true, createdAt: true },
        take: 500,
      });
      recentInboundByCustomer = inbound.reduce((acc, msg) => {
        if (!acc.has(msg.customerId)) acc.set(msg.customerId, []);
        acc.get(msg.customerId).push(msg);
        return acc;
      }, new Map());
    } catch (err) {
      console.error('[Learning] getAll/messages:', err.message);
    }
  }

  const complaintTagCount = new Map();
  for (const c of sortedComplaints.filter((c) => !c.resolved)) {
    for (const tag of c.tags || []) complaintTagCount.set(tag, (complaintTagCount.get(tag) || 0) + 1);
  }

  const statusBuckets = recentOrders.reduce((acc, order) => {
    const key = order.status || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const complaintByPhone = new Map();
  for (const c of sortedComplaints) {
    if (!c.resolved && c.phone && !complaintByPhone.has(c.phone)) complaintByPhone.set(c.phone, c);
  }

  const orderByCustomerId = new Map();
  for (const order of recentOrders) {
    if (order.customerId && !orderByCustomerId.has(order.customerId)) orderByCustomerId.set(order.customerId, order);
  }

  const actionQueue = recentCustomers.map((customer) => {
    const lastMsgs = recentInboundByCustomer.get(customer.id) || [];
    const latestText = (lastMsgs[0]?.text || '').trim();
    const lastOrder = orderByCustomerId.get(customer.id);
    const complaint = complaintByPhone.get(customer.phone);
    const hoursSinceInteraction = customer.lastInteraction ? Math.max(0, Math.round((now - new Date(customer.lastInteraction)) / 36e5)) : null;
    let recommendedAction = 'acompanhar';
    let reason = 'Cliente recente sem ação imediata';
    let priority = 1;

    if (complaint) {
      recommendedAction = 'encaminhar_sac';
      reason = `Reclamação aberta${complaint.tags?.length ? ` (${complaint.tags.join(', ')})` : ''}`;
      priority = 5;
    } else if (lastOrder && ['cw_failed', 'cancelled'].includes(lastOrder.status)) {
      recommendedAction = 'recuperar_pedido';
      reason = `Último pedido com status ${lastOrder.status}`;
      priority = 4;
    } else if (lastOrder && ['in_preparation', 'confirmed', 'dispatched', 'ready'].includes(lastOrder.status)) {
      recommendedAction = 'acompanhar_pedido';
      reason = `Pedido ativo em ${lastOrder.status}`;
      priority = 4;
    } else if (customer.handoff) {
      recommendedAction = 'responder_humano';
      reason = customer.claimedBy ? 'Conversa em handoff aguardando retorno' : 'Conversa na fila sem dono';
      priority = 4;
    } else if (hoursSinceInteraction != null && hoursSinceInteraction <= 24) {
      recommendedAction = 'janela_24h';
      reason = 'Cliente dentro da janela de 24h, bom momento para follow-up';
      priority = 3;
    }

    return {
      customerId: customer.id,
      name: customer.name || customer.phone,
      phone: customer.phone,
      lastInteraction: customer.lastInteraction,
      latestText: latestText.slice(0, 180),
      latestOrderStatus: lastOrder?.status || null,
      latestOrderId: lastOrder?.id || null,
      complaintTags: complaint?.tags || [],
      priority,
      recommendedAction,
      reason,
    };
  }).sort((a, b) => b.priority - a.priority || new Date(b.lastInteraction || 0) - new Date(a.lastInteraction || 0)).slice(0, 20);

  const problemBuckets = [
    { key: 'complaints_open', label: 'Reclamações abertas', count: sortedComplaints.filter((c) => !c.resolved).length },
    { key: 'handoff_open', label: 'Conversas em handoff', count: handoffCustomers },
    { key: 'cw_failed_7d', label: 'Falhas Cardápio Web (7d)', count: cwFailedCount7d },
    { key: 'delay_risk', label: 'Pedidos com risco de atraso', count: delayedOrders },
  ].filter((item) => item.count > 0);

  const insights = [];
  if (problemBuckets.length === 0) {
    insights.push({ type: 'success', text: 'Nenhum gargalo crítico detectado agora. Dá para usar a janela de 24h para reengajar clientes mornos.' });
  } else {
    if (problemBuckets[0]) insights.push({ type: 'warning', text: `${problemBuckets[0].label}: ${problemBuckets[0].count}. Vale atacar isso primeiro.` });
    const topComplaintTag = [...complaintTagCount.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topComplaintTag) insights.push({ type: 'danger', text: `Tema mais sensível nas conversas: ${topComplaintTag[0]} (${topComplaintTag[1]} ocorrência(s)).` });
    if (openWindowCustomers > 0) insights.push({ type: 'info', text: `${openWindowCustomers} cliente(s) falaram nas últimas 24h e podem receber follow-up humano ou recuperação de pedido.` });
  }

  return {
    faq: sortedFaq,
    corrections,
    patterns: sortedPatterns,
    complaints: sortedComplaints,
    actionQueue,
    problemBuckets,
    insights,
    statusBuckets,
    stats: {
      totalFaq: sortedFaq.length,
      totalCorrections: corrections.length,
      totalPatterns: sortedPatterns.length,
      totalComplaints: sortedComplaints.filter((c) => !c.resolved).length,
      totalComplaintsResolved: sortedComplaints.filter((c) => c.resolved).length,
      openWindowCustomers,
      handoffOpen: handoffCustomers,
      cwFailed7d: cwFailedCount7d,
      delayedOrders,
      pendingActions: actionQueue.filter((row) => row.priority >= 3).length,
    },
  };
}

async function deleteFaq(tenantId, index) {
  const faq = await _load(KEYS.faq(tenantId));
  if (index >= 0 && index < faq.length) {
    faq.splice(index, 1);
    await _save(KEYS.faq(tenantId), faq);
  }
}

async function deleteCorrection(tenantId, index) {
  const corrections = await _load(KEYS.corrections(tenantId));
  if (index >= 0 && index < corrections.length) {
    corrections.splice(index, 1);
    await _save(KEYS.corrections(tenantId), corrections);
  }
}

async function addFaq(tenantId, question, answer) {
  return learnFromHandoff(tenantId, question, answer);
}

module.exports = {
  learnFromHandoff,
  learnFromCorrection,
  learnCustomerPattern,
  getLearningContext,
  analyzeConversation,
  analyzeMessage,
  recordComplaint,
  resolveComplaint,
  getAll,
  deleteFaq,
  deleteCorrection,
  addFaq,
};
