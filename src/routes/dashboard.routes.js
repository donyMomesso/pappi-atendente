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

// Normaliza departamento: string -> { name }, objeto -> { name, transferPhone? }
function normalizeDepartment(d) {
  if (typeof d === "string") return { name: d, transferPhone: null };
  return { name: d?.name || "", transferPhone: d?.transferPhone || null };
}

// ── GET /dash/auth ─────────────────────────────────────────────
router.get("/auth", async (req, res) => {
  try {
    const key = req.query.key || req.headers["x-api-key"] || req.headers["x-attendant-key"];
    if (!key) return res.status(401).json({ error: "unauthorized" });

    if (ENV.ADMIN_API_KEY && key === ENV.ADMIN_API_KEY) return res.json({ role: "admin", name: "Admin" });
    if (ENV.ATTENDANT_API_KEY && key === ENV.ATTENDANT_API_KEY)
      return res.json({ role: "attendant", name: "Atendente" });

    const tenantId = req.query.tenant || "tenant-pappi-001";
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

    const email = tokenData.email;
    const tenantId = req.query.tenant || "tenant-pappi-001";
    const cfg = await prisma.config.findUnique({ where: { key: `${tenantId}:google_users` } });
    const users = cfg ? JSON.parse(cfg.value) : [];
    const user = users.find((u) => u.email === email);
    if (!user) return res.status(403).json({ error: "Email não autorizado" });

    return res.json({ name: user.name, role: user.role || "attendant", token: user.key || ENV.ATTENDANT_API_KEY });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/stats ────────────────────────────────────────────
router.get("/stats", authDash, async (req, res) => {
  try {
    const tenantId = req.query.tenant || "tenant-pappi-001";
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [ordersToday, handoffActive, cwFailed] = await Promise.all([
      prisma.order.count({ where: { tenantId, createdAt: { gte: today } } }),
      prisma.customer.count({ where: { tenantId, handoff: true } }),
      prisma.order.count({ where: { tenantId, status: "cw_failed" } }),
    ]);
    res.json({ ordersToday, handoffActive, cwFailed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/conversations ────────────────────────────────────
// Lista conversas: quem tem mensagem nas últimas 24h OU lastInteraction OU handoff ativo
router.get("/conversations", authDash, async (req, res) => {
  try {
    const tenantId = req.query.tenant || "tenant-pappi-001";
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
    const tenantId = req.query.tenant || "tenant-pappi-001";
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
    const tenantId = req.query.tenant || req.body.tenantId || "tenant-pappi-001";
    let { customerId, phone, enabled } = req.body;
    if (!customerId && phone) {
      const { findByPhone } = require("../services/customer.service");
      const c = await findByPhone(tenantId, phone);
      if (c) customerId = c.id;
    }
    if (!customerId) return res.status(400).json({ error: "customerId ou phone obrigatório" });
    await setHandoff(customerId, !!enabled);
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
    await claimFromQueue(customerId, attendant || req.attendant?.name || "Atendente");
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
    const tenantId = req.query.tenant || "tenant-pappi-001";
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

// ── GET /dash/attendants ────────────────────────────────────────
router.get("/attendants", authDash, async (req, res) => {
  try {
    const tenantId = req.query.tenant || "tenant-pappi-001";
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
    const tenantId = req.query.tenant || "tenant-pappi-001";
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
    const { customerId, toAttendant, department, comment, tenantId: bodyTenant } = req.body;
    const tenantId = req.query.tenant || bodyTenant || "tenant-pappi-001";
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

    // Se o departamento tem número de destino, envia notificação por WhatsApp
    if (department) {
      const cfg = await prisma.config.findUnique({ where: { key: `${tenantId}:departments` } });
      const raw = cfg ? JSON.parse(cfg.value) : [];
      const dept = (Array.isArray(raw) ? raw : []).map(normalizeDepartment).find((d) => d.name === department);
      if (dept?.transferPhone) {
        const PhoneNormalizer = require("../normalizers/PhoneNormalizer");
        const toPhone = PhoneNormalizer.normalize(dept.transferPhone);
        if (toPhone) {
          const customer = await prisma.customer.findUnique({ where: { id: customerId } });
          if (customer) {
            const custName = customer.name || "Cliente";
            const custPhone = customer.phone || "—";
            const msg = [
              `🔄 *Transferência para ${department}*`,
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
      botEnabled: s.botEnabled !== false,
      name: s.account?.name || null,
      number: s.account?.phone || null,
      usage: s.usage,
      instanceTenant: s.instanceTenant || null,
    })),
  );
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

// ── GET /dash/catalog ──────────────────────────────────────────
router.get("/catalog", authDash, async (req, res) => {
  try {
    const tenantId = req.query.tenant || "tenant-pappi-001";
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
    const { phone, text, customerId, tenantId: bodyTenant } = req.body;
    const tenantId = req.query.tenant || bodyTenant || "tenant-pappi-001";
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
router.get("/customer/:id/orders", authDash, async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      where: { customerId: req.params.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/orders/kanban ────────────────────────────────────
router.get("/orders/kanban", authDash, async (req, res) => {
  try {
    const tenantId = req.query.tenant || "tenant-pappi-001";
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
    const tenantId = req.query.tenant || "tenant-pappi-001";
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
    const tenantId = req.query.tenant || "tenant-pappi-001";
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });

    const [attendantsCfg, googleCfg, departmentsCfg] = await Promise.all([
      prisma.config.findUnique({ where: { key: `${tenantId}:attendants` } }),
      prisma.config.findUnique({ where: { key: `${tenantId}:google_users` } }),
      prisma.config.findUnique({ where: { key: `${tenantId}:departments` } }),
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
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /dash/settings ──────────────────────────────────────
router.patch("/settings", authAdmin, async (req, res) => {
  try {
    const tenantId = req.query.tenant || req.body.tenantId || "tenant-pappi-001";
    const { name, city, attendants, googleUsers, departments } = req.body;

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
      const normalized = departments.map((d) => ({
        name: typeof d === "string" ? d : (d?.name || ""),
        transferPhone: typeof d === "object" && d?.transferPhone ? String(d.transferPhone).trim() || null : null,
      })).filter((d) => d.name);
      await prisma.config.upsert({
        where: { key: `${tenantId}:departments` },
        create: { key: `${tenantId}:departments`, value: JSON.stringify(normalized) },
        update: { value: JSON.stringify(normalized) },
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
    const tenantId = req.query.tenant || "tenant-pappi-001";
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
    const tenantId = req.query.tenant || "tenant-pappi-001";
    res.json(await prisma.retentionCampaign.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" } }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.post("/retention/campaigns", authAdmin, async (req, res) => {
  try {
    const tenantId = req.query.tenant || req.body.tenantId || "tenant-pappi-001";
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
    res.json(await retention.getMonthlyStats(req.query.tenant || "tenant-pappi-001"));
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

router.get("/debug", authAdmin, async (req, res) => {
  try {
    const tenantId = req.query.tenant || "tenant-pappi-001";
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
    const { wa } = await getClients(req.query.tenant || "tenant-pappi-001");
    res.json(await wa.getTemplates());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/whatsapp/send-template", authDash, async (req, res) => {
  try {
    const { phone, templateName, languageCode, components, tenantId = "tenant-pappi-001" } = req.body;
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
