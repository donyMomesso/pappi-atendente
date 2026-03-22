// src/routes/dashboard.routes.js
// CORREÇÃO: usa singleton do PrismaClient em todo o arquivo
// MELHORIA: rota GET /dash/orders/failed para ver pedidos que falharam no CW

const express = require("express");
const prisma = require("../lib/db");
const { authAdmin, authDash } = require("../middleware/auth.middleware");
const { getClients } = require("../services/tenant.service");
const { setHandoff, releaseHandoff, claimFromQueue, closeConversation } = require("../services/customer.service");
const convState = require("../services/conversation-state.service");
const googleContacts = require("../services/google-contacts.service");
const baileys = require("../services/baileys.service");
const retention = require("../services/retention.service");
const ENV = require("../config/env");

const router = express.Router();

function resolveTenant(req) {
  return req.query.tenant || req.body?.tenantId || req.staffUser?.tenantId;
}

// Normaliza departamento: string -> { name }, objeto -> { name, transferPhone? }
function normalizeDepartment(d) {
  if (typeof d === "string") return { name: d, transferPhone: null };
  return { name: d?.name || "", transferPhone: d?.transferPhone || null };
}

// Envia saudação quando humano assume: "Olá, tudo bem? Aqui quem está falando é [nome]. Em que posso te ajudar?"
async function sendAttendantGreeting(customerId, attendantName, tenantId) {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) return;

  const PhoneNormalizer = require("../normalizers/PhoneNormalizer");
  const normalizedPhone = PhoneNormalizer.normalize(customer.phone) || customer.phone;
  const greeting = `Olá, tudo bem? Aqui quem está falando é *${attendantName}*. Em que posso te ajudar?`;

  const replyChannel = await baileys.getReplyChannel(customerId);
  const useBaileysInstance = replyChannel.startsWith("baileys:") ? replyChannel.replace("baileys:", "") : null;

  if (useBaileysInstance) {
    await baileys.sendText(normalizedPhone, greeting, useBaileysInstance, true);
  } else {
    try {
      const { wa } = await getClients(tenantId || customer.tenantId);
      await wa.sendText(normalizedPhone, greeting);
    } catch (waErr) {
      await baileys.sendText(normalizedPhone, greeting, "default", true).catch(() => {});
    }
  }

  const chatMemory = require("../services/chat-memory.service");
  await chatMemory.push(customerId, "attendant", greeting, attendantName, null, "text", null);
}

// ── GET /dash/auth ─────────────────────────────────────────────
router.get("/auth", async (req, res) => {
  try {
    const key = req.query.key || req.headers["x-api-key"] || req.headers["x-attendant-key"];
    if (!key) return res.status(401).json({ error: "unauthorized" });

    if (ENV.ADMIN_API_KEY && key === ENV.ADMIN_API_KEY) return res.json({ role: "admin", name: "Admin" });
    if (ENV.ATTENDANT_API_KEY && key === ENV.ATTENDANT_API_KEY)
      return res.json({ role: "attendant", name: "Atendente" });

    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    const cfg = await prisma.config.findUnique({ where: { key: `${tenantId}:attendants` } });
    if (cfg) {
      const att = JSON.parse(cfg.value).find((a) => a.key === key);
      if (att) return res.json({ role: att.role || "attendant", name: att.name });
    }
    return res.status(401).json({ error: "unauthorized" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /dash/auth/google ─────────────────────────────────────
router.post("/auth/google", async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: "credential obrigatório" });

    const tokenRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || tokenData.error) return res.status(401).json({ error: "Token Google inválido" });

    const email = (tokenData.email || "").toLowerCase();
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    const cfg = await prisma.config.findUnique({ where: { key: `${tenantId}:google_users` } });
    const users = cfg ? JSON.parse(cfg.value) : [];
    const user = users.find((u) => (u.email || "").toLowerCase() === email);
    if (!user) return res.status(403).json({ error: "Email não autorizado" });

    return res.json({ name: user.name, role: user.role || "attendant", token: user.key || ENV.ATTENDANT_API_KEY });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/stats ────────────────────────────────────────────
router.get("/stats", authDash, async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [ordersToday, handoffActive, cwFailed, delayAlerts] = await Promise.all([
      prisma.order.count({ where: { tenantId, createdAt: { gte: today } } }),
      prisma.customer.count({ where: { tenantId, handoff: true } }),
      prisma.order.count({ where: { tenantId, status: "cw_failed" } }),
      prisma.order.count({
        where: {
          tenantId,
          deliveryRiskLevel: { not: null },
          status: { notIn: ["cancelled", "delivered", "lead"] },
        },
      }),
    ]);
    res.json({ ordersToday, handoffActive, cwFailed, delayAlerts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/conversations ────────────────────────────────────
// Lista conversas: quem tem mensagem nas últimas 24h OU lastInteraction OU handoff ativo
router.get("/conversations", authDash, async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // IDs de clientes com mensagens nas últimas 24h (histórico real, não só lastInteraction)
    const recentMsgRows = await prisma.message.findMany({
      where: {
        createdAt: { gte: since24h },
        customer: { tenantId },
      },
      select: { customerId: true },
      distinct: ["customerId"],
    });
    const idsFromMessages = recentMsgRows.map((r) => r.customerId);

    const customers = await prisma.customer.findMany({
      where: {
        tenantId,
        OR: [
          { lastInteraction: { gte: since24h } },
          { handoff: true },
          ...(idsFromMessages.length ? [{ id: { in: idsFromMessages } }] : []),
        ],
      },
      orderBy: { lastInteraction: "desc" },
      take: 200,
      include: { orders: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    const withState = await Promise.all(
      customers.map(async (c) => {
        const state = await convState.getState(c);
        return {
          ...c,
          phoneFormatted: c.phone.replace(/^55(\d{2})(\d{4,5})(\d{4})$/, "($1) $2-$3"),
          lastOrder: c.orders[0] || null,
          conversationState: state,
        };
      }),
    );
    res.json(withState);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/queue ────────────────────────────────────────────
router.get("/queue", authDash, async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    const customers = await prisma.customer.findMany({
      where: { tenantId, handoff: true },
      orderBy: { queuedAt: "asc" },
      include: { orders: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    const withState = await Promise.all(
      customers.map(async (c) => {
        const state = await convState.getState(c);
        const isUnclaimed = !c.claimedBy;
        return {
          ...c,
          phoneFormatted: c.phone.replace(/^55(\d{2})(\d{4,5})(\d{4})$/, "($1) $2-$3"),
          lastOrder: c.orders[0] || null,
          conversationState: state,
          isUnclaimed,
        };
      }),
    );
    res.json(withState);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /dash/handoff ──────────────────────────────────────────
router.put("/handoff", authDash, async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    let { customerId, phone, enabled, attendant } = req.body;
    if (!customerId && phone) {
      const { findByPhone } = require("../services/customer.service");
      const c = await findByPhone(tenantId, phone);
      if (c) customerId = c.id;
    }
    if (!customerId) return res.status(400).json({ error: "customerId ou phone obrigatório" });
    await setHandoff(customerId, !!enabled);
    // Quando atendente desliga o bot (handoff=true), assume e envia saudação
    if (!!enabled && attendant) {
      const attendantName = attendant || req.attendant?.name || "Atendente";
      await claimFromQueue(customerId, attendantName);
      try {
        await sendAttendantGreeting(customerId, attendantName, tenantId);
      } catch (greetingErr) {
        console.error("[Handoff] Erro ao enviar saudação:", greetingErr.message);
      }
    }
    const socketService = require("../services/socket.service");
    socketService.emitQueueUpdate();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /dash/queue/claim ─────────────────────────────────────
router.post("/queue/claim", authDash, async (req, res) => {
  try {
    const { customerId, attendant } = req.body;
    if (!customerId) return res.status(400).json({ error: "customerId obrigatório" });
    const attendantName = attendant || req.attendant?.name || "Atendente";
    await claimFromQueue(customerId, attendantName);

    try {
      await sendAttendantGreeting(customerId, attendantName);
    } catch (greetingErr) {
      console.error("[Queue/claim] Erro ao enviar saudação:", greetingErr.message);
    }

    const socketService = require("../services/socket.service");
    socketService.emitQueueUpdate();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /dash/queue/release ───────────────────────────────────
router.post("/queue/release", authDash, async (req, res) => {
  try {
    const { customerId } = req.body;
    if (!customerId) return res.status(400).json({ error: "customerId obrigatório" });
    await releaseHandoff(customerId);
    const socketService = require("../services/socket.service");
    socketService.emitQueueUpdate();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /dash/queue/close ─────────────────────────────────────
router.post("/queue/close", authDash, async (req, res) => {
  try {
    const { customerId } = req.body;
    if (!customerId) return res.status(400).json({ error: "customerId obrigatório" });
    await closeConversation(customerId);
    const socketService = require("../services/socket.service");
    socketService.emitQueueUpdate();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/orders/failed — pedidos que falharam no CW ──────
router.get("/orders/failed", authAdmin, async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    const orders = await prisma.order.findMany({
      where: { tenantId, status: { in: ["cw_failed", "waiting_confirmation"] }, cwOrderId: null },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { customer: { select: { name: true, phone: true } } },
    });
    res.json(
      orders.map((o) => ({
        id: o.id,
        orderRef: o.id.slice(-6).toUpperCase(),
        customerName: o.customer?.name,
        customerPhone: o.customer?.phone,
        total: o.total,
        status: o.status,
        fulfillment: o.fulfillment,
        paymentMethodName: o.paymentMethodName,
        createdAt: o.createdAt,
      })),
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /dash/orders/retry — reprocessa um pedido específico ─
router.post("/orders/retry", authAdmin, async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: "orderId obrigatório" });

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { tenant: true },
    });
    if (!order) return res.status(404).json({ error: "Pedido não encontrado" });
    if (!order.cwPayload) return res.status(400).json({ error: "Pedido sem payload CW — não pode ser reenviado" });

    const { getClients } = require("../services/tenant.service");
    const { cw } = await getClients(order.tenantId);
    const cwPayload = JSON.parse(order.cwPayload);
    const cwResponse = await cw.createOrder(cwPayload);
    const cwOrderId = cwResponse?.id || cwResponse?.order_id;

    await prisma.order.update({
      where: { id: orderId },
      data: { cwOrderId, status: "waiting_confirmation", cwResponse: JSON.stringify(cwResponse) },
    });
    await prisma.orderStatusLog.create({
      data: { orderId, status: "cw_retry_success", source: "human", note: "Reenviado manualmente pelo painel" },
    });

    res.json({ ok: true, cwOrderId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/delay-alerts — pedidos em monitoramento de atraso ─
router.get("/delay-alerts", authDash, async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    const orders = await prisma.order.findMany({
      where: {
        tenantId,
        cwOrderId: { not: null },
        deliveryRiskLevel: { not: null },
        status: { notIn: ["cancelled", "delivered", "lead"] },
      },
      orderBy: { delayAlertSentAt: "desc" },
      take: 50,
      include: { customer: { select: { name: true, phone: true, id: true } } },
    });
    res.json(
      orders.map((o) => ({
        id: o.id,
        orderRef: o.id.slice(-6).toUpperCase(),
        customerId: o.customerId,
        customerName: o.customer?.name,
        customerPhone: o.customer?.phone,
        total: o.total,
        status: o.status,
        cardapiowebStatus: o.cardapiowebStatus,
        timeInCurrentStatusMinutes: o.timeInCurrentStatusMinutes,
        estimatedRemainingMin: o.estimatedRemainingMin,
        estimatedRemainingMax: o.estimatedRemainingMax,
        deliveryRiskLevel: o.deliveryRiskLevel,
        watchedByAttendant: o.watchedByAttendant,
        weatherDelayFactor: o.weatherDelayFactor,
        delayAlertSentAt: o.delayAlertSentAt,
        secondDelayAlertSentAt: o.secondDelayAlertSentAt,
        thirdDelayAlertSentAt: o.thirdDelayAlertSentAt,
        couponCode: o.couponCode,
        couponSentAt: o.couponSentAt,
        createdAt: o.createdAt,
      })),
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /dash/orders/:id/watch — marcar acompanhamento por atendente ─
router.post("/orders/:id/watch", authDash, async (req, res) => {
  try {
    const orderId = req.params.id;
    const { watchedBy } = req.body;
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });

    const order = await prisma.order.findFirst({ where: { id: orderId, tenantId } });
    if (!order) return res.status(404).json({ error: "Pedido não encontrado" });

    await prisma.order.update({
      where: { id: orderId },
      data: { watchedByAttendant: watchedBy || req.attendant?.name || "atendente" },
    });
    res.json({ ok: true, watchedBy: watchedBy || req.attendant?.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /dash/orders/:id/compensate — gerar cupom e enviar ao cliente ─
router.post("/orders/:id/compensate", authDash, async (req, res) => {
  try {
    const orderId = req.params.id;
    const { type, reason } = req.body;
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });

    const order = await prisma.order.findFirst({
      where: { id: orderId, tenantId },
      include: { customer: true },
    });
    if (!order) return res.status(404).json({ error: "Pedido não encontrado" });

    const { generateCompensationCoupon, markCouponSent } = require("../services/coupon.service");
    const { getClients } = require("../services/tenant.service");
    const chatMemory = require("../services/chat-memory.service");

    const result = await generateCompensationCoupon({
      orderId,
      type: type || "borda_gratis",
      reason: reason || "atraso",
    });
    if (!result) return res.status(400).json({ error: "Não foi possível gerar cupom" });

    const customerName = order.customer?.name || "Cliente";
    const msg = `${customerName}, olha o que eu consegui para você: uma borda grátis no seu próximo pedido. É só usar o cupom *${result.code}* aqui com a gente que a borda sai grátis. Foi uma forma que consegui para te compensar pela demora de hoje.`;

    if (order.customer?.phone) {
      const { wa } = await getClients(tenantId);
      await wa.sendText(order.customer.phone, msg).catch(() => {});
      await markCouponSent(orderId);
      if (order.customerId) await chatMemory.push(order.customerId, "assistant", msg, "Sistema", null, "text");
    }

    res.json({ ok: true, code: result.code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/audit-logs — logs de auditoria (admin) ────────────
router.get("/audit-logs", authAdmin, async (req, res) => {
  try {
    const tenantId = req.query.tenant;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const where = {};
    if (tenantId && req.staffUser?.tenantId !== tenantId && req.role !== "admin") return res.status(403).json({ error: "forbidden" });
    if (tenantId) where.tenantId = tenantId;

    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    res.json(logs.map((l) => ({
      id: l.id,
      tenantId: l.tenantId,
      userId: l.userId,
      action: l.action,
      resourceType: l.resourceType,
      resourceId: l.resourceId,
      metadata: l.metadata ? JSON.parse(l.metadata) : null,
      ip: l.ip,
      userAgent: l.userAgent,
      createdAt: l.createdAt,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/attendants ────────────────────────────────────────
router.get("/attendants", authDash, async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    const cfg = await prisma.config.findUnique({ where: { key: `${tenantId}:attendants` } });
    const list = cfg ? JSON.parse(cfg.value) : [];
    res.json(list.map((a) => ({ name: a.name, role: a.role || "attendant" })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/departments ────────────────────────────────────────
router.get("/departments", authDash, async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    const cfg = await prisma.config.findUnique({ where: { key: `${tenantId}:departments` } });
    const raw = cfg ? JSON.parse(cfg.value) : [];
    const list = Array.isArray(raw) ? raw : [];
    res.json(list.map(normalizeDepartment).filter((d) => d.name));
  } catch (err) {
    res.status(500).json([]);
  }
});

// ── POST /dash/transfer ─────────────────────────────────────────
router.post("/transfer", authDash, async (req, res) => {
  try {
    const { customerId, toAttendant, department, comment } = req.body;
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    if (!customerId) return res.status(400).json({ error: "customerId obrigatório" });

    await setHandoff(customerId, true);
    if (toAttendant) await claimFromQueue(customerId, toAttendant);

    if (comment || department || toAttendant) {
      const chatMemory = require("../services/chat-memory.service");
      const parts = [];
      if (department) parts.push(`Departamento: ${department}`);
      if (toAttendant) parts.push(`Atendente: ${toAttendant}`);
      if (comment) parts.push(comment);
      await chatMemory.push(customerId, "bot", `🔄 Transferência — ${parts.join(" | ")}`);
    }

    if (toAttendant) {
      try {
        await sendAttendantGreeting(customerId, toAttendant, tenantId);
      } catch (greetingErr) {
        console.error("[Transfer] Erro ao enviar saudação:", greetingErr.message);
      }
    }

    // Só o SAC envia para outro número — usa Config sac_phone
    if (department && department.toUpperCase() === "SAC") {
      const sacCfg = await prisma.config.findUnique({ where: { key: `${tenantId}:sac_phone` } });
      const sacPhone = sacCfg?.value ? sacCfg.value.trim() : null;
      const PhoneNormalizer = require("../normalizers/PhoneNormalizer");
      const toPhone = sacPhone ? PhoneNormalizer.normalize(sacPhone) : null;
      if (toPhone) {
        const customer = await prisma.customer.findUnique({ where: { id: customerId } });
        if (customer) {
          const custName = customer.name || "Cliente";
          const custPhone = customer.phone || "—";
          const msg = [
            `🔄 *Transferência para SAC*`,
            "",
            `Cliente: ${custName}`,
            `Telefone: ${custPhone}`,
            comment ? `Comentário: ${comment}` : "",
          ]
            .filter(Boolean)
            .join("\n");
          try {
            const { wa } = await getClients(tenantId);
            await wa.sendText(toPhone, msg);
          } catch (waErr) {
            await baileys.sendText(toPhone, msg, "default", true).catch(() => {});
          }
        }
      }
    }

    const socketService = require("../services/socket.service");
    socketService.emitQueueUpdate();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/tenants (lista para selector) ────────────────────
router.get("/tenants", authDash, async (_req, res) => {
  try {
    const { listActive } = await import("../services/tenant.service");
    const tenants = await listActive();
    res.json((tenants || []).map((t) => ({ id: t.id, name: t.name })));
  } catch {
    res.json([]);
  }
});

// ── GET /dash/baileys/instances ────────────────────────────────
router.get("/baileys/instances", authDash, async (_req, res) => {
  const list = await baileys.getAllStatuses();
  res.json(
    list.map((s) => ({
      id: s.id,
      status: s.status,
      qr: s.qr,
      qrUrl: s.qr ? `/dash/baileys/instances/${s.id}/qr` : null,
      botEnabled: s.botEnabled !== false,
      name: s.account?.name || null,
      number: s.account?.phone || null,
      usage: s.usage,
      instanceTenant: s.instanceTenant || null,
    })),
  );
});

// ── GET /dash/baileys/instances/:id/qr ─────────────────────────
router.get("/baileys/instances/:id/qr", authDash, async (req, res) => {
  try {
    const status = await baileys.getStatus(req.params.id);
    if (!status?.qr) return res.status(204).end();
    const base64 = status.qr.replace(/^data:image\/\w+;base64,/, "");
    const buf = Buffer.from(base64, "base64");
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-store");
    res.send(buf);
  } catch {
    res.status(204).end();
  }
});

// ── POST /dash/baileys/instances ───────────────────────────────
router.post("/baileys/instances", authAdmin, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: "id obrigatório" });
    await baileys.start(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/baileys/instances/:id/connect", authAdmin, async (req, res) => {
  await baileys.start(req.params.id);
  res.json({ ok: true });
});
router.post("/baileys/instances/:id/disconnect", authAdmin, (req, res) => {
  baileys.disconnect(req.params.id);
  res.json({ ok: true });
});
router.patch("/baileys/instances/:id/bot", authAdmin, (req, res) => {
  baileys.setBotEnabled(req.params.id, req.body.enabled !== false);
  res.json({ ok: true });
});
router.patch("/baileys/instances/:id/tenant", authDash, async (req, res) => {
  try {
    const { tenantId } = req.body;
    await baileys.setInstanceTenant(req.params.id, tenantId || null);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.delete("/baileys/instances/:id", authAdmin, (req, res) => {
  baileys.disconnect(req.params.id);
  res.json({ ok: true });
});

// ── POST /dash/order ───────────────────────────────────────────
router.post("/order", authDash, async (req, res) => {
  try {
    const { randomUUID } = require("crypto");
    const { createWithIdempotency, setCwOrderId } = require("../services/order.service");
    const { recordOrder } = require("../services/customer.service");
    const { calculate, round2 } = require("../calculators/OrderCalculator");

    const {
      tenantId,
      customerId,
      items,
      fulfillment,
      address,
      paymentMethodId,
      paymentMethodName,
      deliveryFee = 0,
      discount = 0,
      trocoPara,
    } = req.body;

    const tid = resolveTenant(req) || tenantId;
    if (!tid) return res.status(400).json({ error: "tenant obrigatório" });
    if (!customerId || !items?.length) {
      return res.status(200).json({ ok: false, error: "Cliente e itens são obrigatórios" });
    }

    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer || customer.tenantId !== tid) {
      return res.status(200).json({ ok: false, error: "Cliente não encontrado" });
    }

    const cart = items.map((i) => {
      const opts = i.options || [];
      const optsSum = opts.reduce((s, o) => s + (parseFloat(o.unit_price) || 0) * (o.quantity || 1), 0);
      const fullPrice = parseFloat(i.unit_price) || 0;
      const basePrice = Math.max(0, fullPrice - optsSum);
      const addons = opts.map((o) => ({
        name: o.name || "",
        unit_price: parseFloat(o.unit_price) || 0,
        quantity: o.quantity || 1,
        id: o.option_id,
      }));
      return {
        id: i.id,
        name: i.name,
        quantity: parseInt(i.quantity, 10) || 1,
        unit_price: basePrice,
        addons,
      };
    });

    const calc = calculate({ items: cart, deliveryFee, discount });
    const idempotencyKey = `${customerId}:${Date.now()}`;

    const cwOrderId = randomUUID();
    const displayId = cwOrderId.slice(-6).toUpperCase();
    const phone11 = (customer.phone || "").replace(/\D/g, "").slice(-11);

    const cwPayload = {
      order_id: cwOrderId,
      display_id: displayId,
      order_type: fulfillment === "delivery" ? "delivery" : "takeout",
      created_at: new Date().toISOString(),
      customer: phone11 ? { phone: phone11, name: customer.name || "Cliente" } : null,
      totals: {
        order_amount: calc.expectedTotal,
        delivery_fee: round2(deliveryFee),
        additional_fee: 0,
        discounts: round2(discount),
      },
      items: cart.map((i) => {
        const addonsSum = (i.addons || []).reduce(
          (s, a) => s + (a.unit_price || 0) * (a.quantity || 1),
          0,
        );
        return {
          ...(i.id ? { item_id: String(i.id) } : {}),
          name: i.name,
          quantity: i.quantity,
          unit_price: i.unit_price,
          total_price: round2((i.unit_price + addonsSum) * i.quantity),
          ...((i.addons || []).length
            ? {
                options: i.addons.map((a) => ({
                  name: a.name,
                  quantity: a.quantity || 1,
                  unit_price: a.unit_price || 0,
                  ...(a.id ? { option_id: String(a.id) } : {}),
                })),
              }
            : {}),
        };
      }),
      payments: [
        {
          total: calc.expectedTotal,
          payment_method_id: parseInt(paymentMethodId, 10) || paymentMethodId,
          ...(trocoPara && parseFloat(trocoPara) > calc.expectedTotal
            ? { change_for: parseFloat(trocoPara) }
            : {}),
        },
      ],
      ...(trocoPara && parseFloat(trocoPara) > 0
        ? { observation: `Troco para R$ ${parseFloat(trocoPara).toFixed(2)}` }
        : {}),
    };

    if (fulfillment === "delivery" && address) {
      const postalCode = (address.zipCode || address.postal_code || "").replace(/\D/g, "").slice(0, 8);
      if (postalCode.length < 8) {
        return res.status(200).json({ ok: false, error: "CEP é obrigatório para entrega (8 dígitos)" });
      }
      cwPayload.delivery_address = {
        state: (address.state || "SP").slice(0, 2),
        city: address.city || "",
        neighborhood: address.neighborhood || "",
        street: address.street || "",
        number: String(address.number || ""),
        ...(address.complement ? { complement: address.complement } : {}),
        postal_code: postalCode,
        coordinates: {
          latitude: parseFloat(address.lat) || 0,
          longitude: parseFloat(address.lng) || 0,
        },
      };
      cwPayload.totals.delivery_fee = round2(deliveryFee);
    }

    let cwResponse = null;
    let createdCwOrderId = null;
    try {
      const { cw } = await getClients(tid);
      cwResponse = await cw.createOrder(cwPayload);
      createdCwOrderId = cwResponse?.id || cwResponse?.order_id;
    } catch (cwErr) {
      console.error(`[${tid}] CW createOrder:`, cwErr.message);
      const errMsg = cwErr?.data?.errors?.join?.(" ") || cwErr.message;
      return res.status(200).json({ ok: false, error: errMsg || "Falha ao enviar ao CardápioWeb" });
    }

    const itemsForDb = cart.map((i) => ({
      id: i.id,
      name: i.name,
      quantity: i.quantity,
      unit_price: i.unit_price,
      addons: i.addons,
    }));

    const { order } = await createWithIdempotency({
      tenantId: tid,
      customerId,
      idempotencyKey,
      items: itemsForDb,
      total: calc.expectedTotal,
      deliveryFee,
      discount,
      paymentMethodId,
      paymentMethodName,
      fulfillment,
      address: fulfillment === "delivery" ? address : null,
      cwOrderId: createdCwOrderId,
      cwPayload,
      cwResponse,
    });

    if (createdCwOrderId) await setCwOrderId(order.id, createdCwOrderId, cwResponse);

    const summary = cart
      .map((i) => `• ${i.quantity}x ${i.name} — R$ ${(i.unit_price * i.quantity).toFixed(2)}`)
      .join("\n");
    await recordOrder(customerId, summary, paymentMethodName);

    return res.status(200).json({
      ok: true,
      cwOrderId: createdCwOrderId,
      orderId: order.id,
    });
  } catch (err) {
    console.error("[dash/order]", err);
    return res.status(200).json({ ok: false, error: err.message || "Tente novamente" });
  }
});

// ── GET /dash/catalog ──────────────────────────────────────────
router.get("/catalog", authDash, async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    const { cw } = await getClients(tenantId);
    const [rawCatalog, payments] = await Promise.all([cw.getCatalog(), cw.getPaymentMethods().catch(() => [])]);
    const catalog = rawCatalog?.catalog || rawCatalog;
    res.json({ catalog, payments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /dash/send ────────────────────────────────────────────
router.post("/send", authDash, async (req, res) => {
  try {
    const { phone, text, customerId } = req.body;
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    if (!phone || !text) return res.status(400).json({ error: "phone e text obrigatórios" });

    const PhoneNormalizer = require("../normalizers/PhoneNormalizer");
    const normalizedPhone = PhoneNormalizer.normalize(phone) || phone;

    let waMessageId = null;
    const replyChannel = customerId ? await baileys.getReplyChannel(customerId) : "cloud";
    const useBaileysInstance = replyChannel.startsWith("baileys:") ? replyChannel.replace("baileys:", "") : null;

    if (useBaileysInstance) {
      const sent = await baileys.sendText(normalizedPhone, text, useBaileysInstance, true);
      if (!sent) throw new Error("Falha ao enviar via WhatsApp interno");
    } else {
      try {
        const { wa } = await getClients(tenantId);
        const result = await wa.sendText(normalizedPhone, text);
        waMessageId = result?.messages?.[0]?.id;
      } catch (waErr) {
        const sent = await baileys.sendText(normalizedPhone, text, "default", true);
        if (!sent) throw waErr;
      }
    }

    if (customerId) {
      const chatMemory = require("../services/chat-memory.service");
      await chatMemory.push(
        customerId,
        "attendant",
        text,
        req.attendant?.name || "Atendente",
        null,
        "text",
        waMessageId,
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/messages/:customerId ───────────────────────────
router.get("/messages/:customerId", authDash, async (req, res) => {
  try {
    const chatMemory = require("../services/chat-memory.service");
    const messages = await chatMemory.get(req.params.customerId);
    res.json(Array.isArray(messages) ? messages : []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/customer/:id/messages ──────────────────────────
router.get("/customer/:id/messages", authDash, async (req, res) => {
  try {
    const chatMemory = require("../services/chat-memory.service");
    const messages = await chatMemory.get(req.params.id);
    res.json(Array.isArray(messages) ? messages : []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/customer/:id/orders ─────────────────────────────
// Retorna pedidos do nosso DB + histórico do CardapioWeb (extraído por telefone)
router.get("/customer/:id/orders", authDash, async (req, res) => {
  try {
    const customerId = req.params.id;
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { phone: true },
    });
    if (!customer) return res.json([]);

    const dbOrders = await prisma.order.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
      take: 30,
    });

    const mapCwStatus = (s) => {
      const t = String(s || "").toLowerCase();
      if (t.includes("confirm") || t === "confirmed") return "confirmed";
      if (t.includes("prepar") || t === "in_preparation") return "in_preparation";
      if (t.includes("dispatch") || t === "dispatched") return "dispatched";
      if (t.includes("conclu") || t === "concluded" || t === "delivered") return "concluded";
      if (t.includes("cancel")) return "cancelled";
      return t || "waiting_confirmation";
    };

    const toDisplayFormat = (o, source = "db") => {
      let items = [];
      if (source === "db" && o.itemsSnapshot) {
        try {
          items = JSON.parse(o.itemsSnapshot);
        } catch {}
      } else if (source === "cw" && o.items) {
        items = Array.isArray(o.items) ? o.items : [];
      } else if (source === "cw" && o.order_items) {
        items = (o.order_items || []).map((i) => ({
          quantity: i.quantity || 1,
          name: i.name || i.product_name || i.description || "Item",
        }));
      }
      return {
        id: o.id,
        cwOrderId: o.id || o.cwOrderId || o.order_id,
        status: mapCwStatus(o.status),
        total: parseFloat(o.total ?? o.totals?.order_amount ?? o.order_amount ?? 0) || 0,
        fulfillment: (o.order_type || o.fulfillment || "delivery") === "takeout" ? "takeout" : "delivery",
        paymentMethodName: o.payment_method_name || o.paymentMethodName || "—",
        items: items.map((i) => ({
          quantity: i.quantity || 1,
          name: i.name || i.product_name || i.description || "Item",
        })),
        createdAt: o.created_at || o.createdAt,
      };
    };

    const seen = new Set();
    const merged = [];
    for (const o of dbOrders) {
      const formatted = toDisplayFormat(o, "db");
      const key = o.cwOrderId || o.id;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(formatted);
      }
    }

    let cwOrders = [];
    try {
      const { cw } = await getClients(tenantId);
      cwOrders = (await cw.listOrdersByPhone(customer.phone, 30)) || [];
    } catch (e) {
      console.warn("[Customer orders] CW listOrdersByPhone:", e.message);
    }

    for (const o of cwOrders) {
      const cwId = o.id || o.order_id;
      if (cwId && !seen.has(cwId)) {
        seen.add(cwId);
        merged.push(toDisplayFormat(o, "cw"));
      }
    }

    merged.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(merged.slice(0, 30));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/orders/kanban ────────────────────────────────────
router.get("/orders/kanban", authDash, async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const orders = await prisma.order.findMany({
      where: { tenantId, createdAt: { gte: today } },
      orderBy: { createdAt: "desc" },
      include: { customer: { select: { name: true, phone: true } } },
    });

    const columns = {
      waiting_confirmation: [],
      confirmed: [],
      in_preparation: [],
      dispatched: [],
      concluded: [],
      cancelled: [],
      cw_failed: [],
    };

    for (const o of orders) {
      const col = columns[o.status] ? o.status : "waiting_confirmation";
      const items = (() => {
        try {
          return JSON.parse(o.itemsSnapshot);
        } catch {
          return [];
        }
      })();
      columns[col].push({
        id: o.id,
        cwOrderId: o.cwOrderId,
        customerName: o.customer?.name || o.customer?.phone || "—",
        total: o.total,
        fulfillment: o.fulfillment,
        paymentMethodName: o.paymentMethodName,
        createdAt: o.createdAt,
        items,
      });
    }
    res.json(columns);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/customers ──────────────────────────────────────
router.get("/customers", authDash, async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    const customers = await prisma.customer.findMany({
      where: { tenantId },
      orderBy: { lastInteraction: "desc" },
      take: 50,
    });
    res.json(customers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/settings ────────────────────────────────────────
router.get("/settings", authAdmin, async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });

    const [attendantsCfg, googleCfg, departmentsCfg, sacCfg] = await Promise.all([
      prisma.config.findUnique({ where: { key: `${tenantId}:attendants` } }),
      prisma.config.findUnique({ where: { key: `${tenantId}:google_users` } }),
      prisma.config.findUnique({ where: { key: `${tenantId}:departments` } }),
      prisma.config.findUnique({ where: { key: `${tenantId}:sac_phone` } }),
    ]);

    const departmentsRaw = departmentsCfg ? JSON.parse(departmentsCfg.value) : [];
    const departments = (Array.isArray(departmentsRaw) ? departmentsRaw : []).map(normalizeDepartment);
    res.json({
      id: tenant.id,
      name: tenant.name,
      city: tenant.city,
      waPhoneNumberId: tenant.waPhoneNumberId,
      cwBaseUrl: tenant.cwBaseUrl,
      cwStoreId: tenant.cwStoreId,
      active: tenant.active,
      attendants: attendantsCfg ? JSON.parse(attendantsCfg.value) : [],
      googleUsers: googleCfg ? JSON.parse(googleCfg.value) : [],
      departments,
      sacPhone: sacCfg?.value?.trim() || "",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /dash/settings ──────────────────────────────────────
router.patch("/settings", authAdmin, async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    const { name, city, attendants, googleUsers, departments, sacPhone } = req.body;

    const data = {};
    if (name !== undefined) data.name = name;
    if (city !== undefined) data.city = city;
    if (Object.keys(data).length) {
      await prisma.tenant.update({ where: { id: tenantId }, data });
      const { invalidateCache } = require("../services/tenant.service");
      invalidateCache(tenantId);
    }

    if (Array.isArray(attendants)) {
      await prisma.config.upsert({
        where: { key: `${tenantId}:attendants` },
        create: { key: `${tenantId}:attendants`, value: JSON.stringify(attendants) },
        update: { value: JSON.stringify(attendants) },
      });
    }
    if (Array.isArray(googleUsers)) {
      await prisma.config.upsert({
        where: { key: `${tenantId}:google_users` },
        create: { key: `${tenantId}:google_users`, value: JSON.stringify(googleUsers) },
        update: { value: JSON.stringify(googleUsers) },
      });
    }
    if (Array.isArray(departments)) {
      const normalized = departments
        .map((d) => ({ name: typeof d === "string" ? d : d?.name || "" }))
        .filter((d) => d.name);
      await prisma.config.upsert({
        where: { key: `${tenantId}:departments` },
        create: { key: `${tenantId}:departments`, value: JSON.stringify(normalized) },
        update: { value: JSON.stringify(normalized) },
      });
    }
    if (sacPhone !== undefined) {
      const val = String(sacPhone || "").trim();
      await prisma.config.upsert({
        where: { key: `${tenantId}:sac_phone` },
        create: { key: `${tenantId}:sac_phone`, value: val },
        update: { value: val },
      });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/stats/report ────────────────────────────────────
router.get("/stats/report", authAdmin, async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    const days = Math.min(parseInt(req.query.days || "7"), 90);
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const [msgSent, msgReceived, orders, uniqueCustomers, handoffs, handoffsOpen, topCustomers, cwFailed] =
      await Promise.all([
        prisma.message.count({
          where: { customer: { tenantId }, role: { in: ["assistant", "attendant"] }, createdAt: { gte: since } },
        }),
        prisma.message.count({ where: { customer: { tenantId }, role: "customer", createdAt: { gte: since } } }),
        prisma.order.count({ where: { tenantId, createdAt: { gte: since } } }),
        prisma.customer.count({ where: { tenantId, lastInteraction: { gte: since } } }),
        prisma.customer.count({ where: { tenantId, handoffAt: { gte: since } } }),
        prisma.customer.count({ where: { tenantId, handoff: true } }),
        prisma.customer.findMany({
          where: { tenantId, visitCount: { gt: 0 } },
          orderBy: { visitCount: "desc" },
          take: 5,
          select: { name: true, phone: true, visitCount: true },
        }),
        prisma.order.count({ where: { tenantId, status: "cw_failed" } }),
      ]);

    res.json({
      msgSent,
      msgReceived,
      orders,
      uniqueCustomers,
      handoffs,
      handoffsClosed: handoffs - handoffsOpen,
      handoffsOpen,
      topCustomers,
      cwFailed,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Demais rotas de Google Contacts, Baileys, Retention, etc. ─

router.get("/google-contacts/auth-url", authAdmin, (_req, res) => res.json({ url: googleContacts.getAuthUrl() }));
router.get("/google-contacts/status", authAdmin, async (_req, res) =>
  res.json({ authorized: await googleContacts.isAuthorized() }),
);
router.post("/google-contacts/disconnect", authAdmin, async (_req, res) => {
  await googleContacts.disconnect();
  res.json({ ok: true });
});
router.get("/google-contacts/search", authDash, async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json([]);
  res.json(await googleContacts.searchContacts(q));
});

// Busca clientes do tenant (WhatsApp — quem já interagiu)
router.get("/customers/search", authDash, async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    if (!q || q.length < 2) return res.json([]);
    const digits = q.replace(/\D/g, "");
    const orCond = [];
    if (q.length >= 2) orCond.push({ name: { contains: q, mode: "insensitive" } });
    if (digits.length >= 2) orCond.push({ phone: { contains: digits } });
    if (!orCond.length) return res.json([]);
    const customers = await prisma.customer.findMany({
      where: { tenantId, OR: orCond },
      select: { name: true, phone: true },
      orderBy: { lastInteraction: "desc" },
      take: 20,
    });
    res.json(customers.map((c) => ({ name: c.name || null, phone: c.phone })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/google-contacts/callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send("Código ausente.");
    const tokens = await googleContacts.exchangeCode(code);
    await googleContacts.saveTokens(tokens);
    res.send(
      `<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>✅ Google Contacts autorizado!</h2><script>setTimeout(()=>window.close(),3000)</script></body></html>`,
    );
  } catch (err) {
    res.status(500).send("Erro: " + err.message);
  }
});

router.get("/retention/campaigns", authAdmin, async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    res.json(await prisma.retentionCampaign.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.post("/retention/campaigns", authAdmin, async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    const { name, message, delayHours = 20, monthlyLimit = 100, aiFilter = true } = req.body;
    if (!name || !message) return res.status(400).json({ error: "name e message obrigatórios" });
    res.json(
      await prisma.retentionCampaign.create({
        data: { tenantId, name, message, delayHours: +delayHours, monthlyLimit: +monthlyLimit, aiFilter: !!aiFilter },
      }),
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.patch("/retention/campaigns/:id", authAdmin, async (req, res) => {
  try {
    const data = {};
    for (const k of ["name", "message", "delayHours", "monthlyLimit", "aiFilter", "active"])
      if (req.body[k] !== undefined)
        data[k] =
          typeof req.body[k] === "boolean"
            ? req.body[k]
            : k === "active" || k === "aiFilter"
              ? !!req.body[k]
              : ["delayHours", "monthlyLimit"].includes(k)
                ? +req.body[k]
                : req.body[k];
    res.json(await prisma.retentionCampaign.update({ where: { id: req.params.id }, data }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.delete("/retention/campaigns/:id", authAdmin, async (req, res) => {
  try {
    await prisma.retentionCampaign.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.post("/retention/run", authAdmin, async (_req, res) => {
  retention.runAll().catch((err) => console.error("[Retention] run manual:", err.message));
  res.json({ ok: true });
});
router.get("/retention/stats", authAdmin, async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    res.json(await retention.getMonthlyStats(tenantId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/wa-internal/status", authDash, async (_req, res) => res.json(await baileys.getAllStatuses()));
router.post("/wa-internal/connect", authAdmin, async (req, res) => {
  try {
    await baileys.start(req.body.instanceId || "default");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.post("/wa-internal/disconnect", authAdmin, (req, res) => {
  baileys.disconnect(req.body.instanceId || "default");
  res.json({ ok: true });
});

// GET /dash/broadcast/contacts — Contatos para transmissão com filtros (admin only)
router.get("/broadcast/contacts", authAdmin, async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    const period = req.query.period || "all"; // this_week | this_month | 3_months | over_3_months | all
    const janela24h = req.query.janela24h === "true" || req.query.janela24h === "1";
    const limit = Math.min(500, Math.max(25, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    const now = new Date();
    const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const since90d = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    let customerIds = null;
    if (period !== "all") {
      const orderFilter =
        period === "this_week"
          ? { createdAt: { gte: since7d } }
          : period === "this_month"
            ? { createdAt: { gte: since30d } }
            : period === "3_months"
              ? { createdAt: { gte: since90d } }
              : period === "over_3_months"
                ? { createdAt: { lt: since90d } }
                : {};
      if (period === "over_3_months") {
        const orderedRecently = await prisma.order.findMany({
          where: { tenantId, createdAt: { gte: since90d } },
          select: { customerId: true },
          distinct: ["customerId"],
        });
        const recentIds = new Set(orderedRecently.map((o) => o.customerId));
        const allCustomers = await prisma.customer.findMany({
          where: { tenantId },
          select: { id: true },
        });
        customerIds = allCustomers.filter((c) => !recentIds.has(c.id)).map((c) => c.id);
      } else {
        const orders = await prisma.order.findMany({
          where: { tenantId, ...orderFilter },
          select: { customerId: true },
          distinct: ["customerId"],
        });
        customerIds = orders.map((o) => o.customerId);
      }
    }

    const where = { tenantId };
    if (customerIds && customerIds.length > 0) where.id = { in: customerIds };
    else if (customerIds && customerIds.length === 0) return res.json({ contacts: [], total: 0 });
    if (janela24h) where.lastInteraction = { gte: since24h };

    const [contacts, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        select: { id: true, phone: true, name: true, lastInteraction: true },
        orderBy: { lastInteraction: "desc" },
        skip: offset,
        take: limit,
      }),
      prisma.customer.count({ where }),
    ]);

    res.json({
      contacts: contacts.map((c) => ({
        id: c.id,
        phone: c.phone,
        name: c.name || "Sem nome",
        lastInteraction: c.lastInteraction,
      })),
      total,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /dash/broadcast — Lista de transmissão (admin only, usa WhatsApp Interno/Baileys)
router.post("/broadcast", authAdmin, async (req, res) => {
  try {
    const { numbers, message, instanceId = "default", delayMs = 5000 } = req.body;
    if (!Array.isArray(numbers) || numbers.length === 0 || !message || typeof message !== "string")
      return res.status(400).json({ error: "numbers (array) e message (string) obrigatórios" });
    const delay = Math.max(3000, Math.min(60000, parseInt(delayMs, 10) || 5000));
    const result = await baileys.broadcastSend(numbers, message.trim(), instanceId, delay);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.patch("/wa-internal/numbers", authAdmin, (req, res) => {
  baileys.setNotifyNumbers(Array.isArray(req.body.numbers) ? req.body.numbers : [], req.body.instanceId || "default");
  res.json({ ok: true });
});

router.get("/customer/:id/avatar", authDash, async (req, res) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id }, select: { phone: true } });
    if (!customer) return res.status(404).end();
    const url = await baileys.getProfilePicture(customer.phone).catch(() => null);
    if (url) return res.redirect(url);
    res.status(204).end();
  } catch {
    res.status(204).end();
  }
});

// Perfil WhatsApp (foto) por telefone — para enriquecer contatos
router.get("/contact/wa-profile", authDash, async (req, res) => {
  try {
    const phone = (req.query.phone || "").replace(/\D/g, "");
    if (!phone || phone.length < 10) return res.status(400).json({ error: "phone obrigatório" });
    const url = await baileys.getProfilePicture(phone).catch(() => null);
    res.json({ profilePictureUrl: url || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/debug", authAdmin, async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    const [tenant, recentCustomers] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tenantId } }),
      prisma.customer.findMany({
        where: { tenantId },
        orderBy: { lastInteraction: "desc" },
        take: 5,
        select: { phone: true, name: true, lastInteraction: true },
      }),
    ]);
    res.json({
      tenant: { id: tenant?.id, name: tenant?.name, waPhoneNumberId: tenant?.waPhoneNumberId, active: tenant?.active },
      recentCustomers,
      baileysStatus: await baileys.getAllStatuses(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/whatsapp/templates", authDash, async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    const { wa } = await getClients(tenantId);
    res.json(await wa.getTemplates());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/whatsapp/send-template", authDash, async (req, res) => {
  try {
    const { phone, templateName, languageCode, components } = req.body;
    const tenantId = resolveTenant(req) || req.body.tenantId;
    if (!tenantId) return res.status(400).json({ error: "tenant obrigatório" });
    if (!phone || !templateName) return res.status(400).json({ error: "phone e templateName obrigatórios" });
    const { wa } = await getClients(tenantId);
    res.json({
      ok: true,
      result: await wa.sendTemplate(phone, templateName, languageCode || "pt_BR", components || []),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
