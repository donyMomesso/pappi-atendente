// src/routes/dashboard.routes.js
const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { requireAttendantKey } = require("../middleware/auth.middleware");
const { setHandoff, claimFromQueue, releaseHandoff } = require("../services/customer.service");
const { getClients } = require("../services/tenant.service");
const { createWithIdempotency } = require("../services/order.service");
const { validate: validateTotal } = require("../calculators/OrderCalculator");
const { map: mapPayment } = require("../mappers/PaymentMapper");
const { normalize: normalizeAddress } = require("../normalizers/AddressNormalizer");
const PhoneNormalizer = require("../normalizers/PhoneNormalizer");
const { randomUUID } = require("crypto");
const baileys = require("../services/baileys.service");

const prisma = new PrismaClient();
const router = express.Router();

// ── Helpers de autenticação ────────────────────────────────────
function getKey(req) {
  return req.headers["x-api-key"]
    || req.query.key
    || req.headers["authorization"]?.replace("Bearer ", "");
}

function getRole(key) {
  const ENV = require("../config/env");
  if (ENV.ADMIN_API_KEY && key === ENV.ADMIN_API_KEY) return "admin";
  if (ENV.ATTENDANT_API_KEY && key === ENV.ATTENDANT_API_KEY) return "attendant";
  return null;
}

// Aceita admin ou atendente
function authDash(req, res, next) {
  const role = getRole(getKey(req));
  if (!role) return res.status(401).json({ error: "unauthorized" });
  req.userRole = role;
  next();
}

// Somente admin
function authAdmin(req, res, next) {
  const role = getRole(getKey(req));
  if (role !== "admin") return res.status(403).json({ error: "forbidden" });
  req.userRole = "admin";
  next();
}

// ── GET /dash/auth ─────────────────────────────────────────────
// Valida chave e retorna role
router.get("/auth", (req, res) => {
  const role = getRole(getKey(req));
  if (!role) return res.status(401).json({ error: "unauthorized" });
  res.json({ role });
});

// ── GET /dash/stats ────────────────────────────────────────────
router.get("/stats", authDash, async (req, res) => {
  try {
    const tenantId = req.query.tenant || "tenant-pappi-001";
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [ordersToday, ordersTotal, customersTotal, handoffActive, ordersByStatus] =
      await Promise.all([
        prisma.order.count({ where: { tenantId, createdAt: { gte: today } } }),
        prisma.order.count({ where: { tenantId } }),
        prisma.customer.count({ where: { tenantId } }),
        prisma.customer.count({ where: { tenantId, handoff: true } }),
        prisma.order.groupBy({
          by: ["status"],
          where: { tenantId, createdAt: { gte: today } },
          _count: { id: true },
        }),
      ]);

    const revenueToday = await prisma.order.aggregate({
      where: { tenantId, createdAt: { gte: today }, status: { not: "cancelled" } },
      _sum: { total: true },
    });

    res.json({
      ordersToday,
      ordersTotal,
      customersTotal,
      handoffActive,
      revenueToday: revenueToday._sum.total || 0,
      ordersByStatus: ordersByStatus.map((s) => ({ status: s.status, count: s._count.id })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/conversations ────────────────────────────────────
router.get("/conversations", authDash, async (req, res) => {
  try {
    const tenantId = req.query.tenant || "tenant-pappi-001";
    const customers = await prisma.customer.findMany({
      where: { tenantId },
      orderBy: { lastInteraction: "desc" },
      take: 50,
      include: {
        orders: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    res.json(
      customers.map((c) => ({
        id: c.id,
        phone: c.phone,
        phoneFormatted: PhoneNormalizer.format(c.phone),
        name: c.name || "Sem nome",
        handoff: c.handoff,
        lastInteraction: c.lastInteraction,
        lastAddress: c.lastAddress,
        visitCount: c.visitCount,
        lastOrder: c.orders[0]
          ? {
              id: c.orders[0].id,
              status: c.orders[0].status,
              total: c.orders[0].total,
              createdAt: c.orders[0].createdAt,
            }
          : null,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/orders ───────────────────────────────────────────
router.get("/orders", authDash, async (req, res) => {
  try {
    const tenantId = req.query.tenant || "tenant-pappi-001";
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const orders = await prisma.order.findMany({
      where: { tenantId, createdAt: { gte: today } },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { customer: { select: { name: true, phone: true } } },
    });

    res.json(
      orders.map((o) => ({
        id: o.id,
        cwOrderId: o.cwOrderId,
        status: o.status,
        total: o.total,
        deliveryFee: o.deliveryFee,
        fulfillment: o.fulfillment,
        paymentMethodName: o.paymentMethodName,
        createdAt: o.createdAt,
        customer: {
          name: o.customer.name || "Sem nome",
          phone: PhoneNormalizer.format(o.customer.phone),
        },
        items: (() => {
          try { return JSON.parse(o.itemsSnapshot); } catch { return []; }
        })(),
        address: (() => {
          try { return JSON.parse(o.addressSnapshot || "null"); } catch { return null; }
        })(),
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/queue ───────────────────────────────────────────
// Retorna fila de espera: não reclamados + reclamados pelo atendente atual
router.get("/queue", authDash, async (req, res) => {
  try {
    const tenantId = req.query.tenant || "tenant-pappi-001";
    const attendant = req.query.attendant || null;

    const customers = await prisma.customer.findMany({
      where: {
        tenantId,
        handoff: true,
        queuedAt: { not: null },
      },
      orderBy: { queuedAt: "asc" },
      include: {
        orders: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });

    res.json(customers.map(c => ({
      id: c.id,
      phone: c.phone,
      phoneFormatted: PhoneNormalizer.format(c.phone),
      name: c.name || "Sem nome",
      queuedAt: c.queuedAt,
      claimedBy: c.claimedBy,
      isMine: attendant && c.claimedBy === attendant,
      isUnclaimed: !c.claimedBy,
      lastOrder: c.orders[0] ? {
        status: c.orders[0].status,
        total: c.orders[0].total,
      } : null,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /dash/queue/claim ─────────────────────────────────────
router.post("/queue/claim", authDash, async (req, res) => {
  try {
    const { customerId, attendant, tenantId = "tenant-pappi-001" } = req.body;
    if (!customerId || !attendant) return res.status(400).json({ error: "customerId e attendant obrigatórios" });

    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) return res.status(404).json({ error: "Cliente não encontrado" });
    if (customer.claimedBy && customer.claimedBy !== attendant) {
      return res.status(409).json({ error: `Já assumido por ${customer.claimedBy}` });
    }

    const updated = await claimFromQueue(customerId, attendant);

    // Notifica o cliente
    try {
      const { wa } = await getClients(tenantId);
      await wa.sendText(customer.phone, `👨‍💼 *${attendant}* está te atendendo agora. Como posso te ajudar?`);
    } catch { /* ignora */ }

    res.json({ ok: true, claimedBy: updated.claimedBy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /dash/queue/release ──────────────────────────────────
// Encerra atendimento humano e volta ao fluxo do bot
router.post("/queue/release", authDash, async (req, res) => {
  try {
    const { customerId, tenantId = "tenant-pappi-001" } = req.body;
    if (!customerId) return res.status(400).json({ error: "customerId obrigatório" });

    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) return res.status(404).json({ error: "Cliente não encontrado" });

    await releaseHandoff(customerId);

    // Avisa o cliente que voltou ao bot
    try {
      const { wa } = await getClients(tenantId);
      await wa.sendText(customer.phone, "✅ Atendimento encerrado. Se precisar de algo, é só chamar! 😊");
    } catch { /* ignora */ }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /dash/handoff ─────────────────────────────────────────
router.put("/handoff", authDash, async (req, res) => {
  try {
    const { customerId, enabled, tenantId = "tenant-pappi-001" } = req.body;
    if (!customerId) return res.status(400).json({ error: "customerId obrigatório" });

    const customer = await setHandoff(customerId, enabled);

    // Notifica o cliente se for assumir
    if (enabled) {
      try {
        const { wa } = await getClients(tenantId);
        await wa.sendText(
          customer.phone,
          "👨‍💼 Um atendente assumiu sua conversa. Como posso te ajudar?"
        );
      } catch { /* ignora erro de envio */ }
    }

    res.json({ ok: true, handoff: customer.handoff });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /dash/send ───────────────────────────────────────────
router.post("/send", authDash, async (req, res) => {
  try {
    const { phone, text, tenantId = "tenant-pappi-001" } = req.body;
    if (!phone || !text) return res.status(400).json({ error: "phone e text obrigatórios" });

    const normalized = PhoneNormalizer.normalize(phone);
    if (!normalized) return res.status(400).json({ error: "Telefone inválido" });

    const { wa } = await getClients(tenantId);
    await wa.sendText(normalized, text);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/catalog ─────────────────────────────────────────
router.get("/catalog", authDash, async (req, res) => {
  try {
    const tenantId = req.query.tenant || "tenant-pappi-001";
    const { cw } = await getClients(tenantId);
    const catalog = await cw.getCatalog();
    const payments = await cw.getPaymentMethods();
    res.json({ catalog, payments });
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
    res.json(orders.map(o => ({
      ...o,
      items: (() => { try { return JSON.parse(o.itemsSnapshot); } catch { return []; } })(),
      address: (() => { try { return JSON.parse(o.addressSnapshot || "null"); } catch { return null; } })(),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /dash/order ──────────────────────────────────────────
// Cria pedido manual pelo painel (atendente monta o pedido)
router.post("/order", authDash, async (req, res) => {
  try {
    const {
      tenantId = "tenant-pappi-001",
      customerId,
      items,
      fulfillment = "delivery",
      address,
      paymentMethodId,
      paymentMethodName,
      deliveryFee = 0,
      discount = 0,
    } = req.body;

    if (!customerId || !items?.length) {
      return res.status(400).json({ error: "customerId e items obrigatórios" });
    }

    const { cw } = await getClients(tenantId);
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) return res.status(404).json({ error: "Cliente não encontrado" });

    // Calcula total
    const calc = validateTotal({ items, declaredTotal: 0, deliveryFee, discount });
    const total = calc.expected;

    // Monta payload CW
    const cwPayload = {
      customer: { phone: PhoneNormalizer.toLocal(customer.phone), name: customer.name || "" },
      items: items.map(i => ({
        product_id: i.id,
        quantity: i.quantity,
        note: i.note || "",
        options: (i.options || i.addons || []).map(o => ({
          option_group_id: o.option_group_id,
          option_id: o.option_id || o.id,
          quantity: o.quantity || 1,
        })),
      })),
      fulfillment,
      payment_method: paymentMethodId,
      delivery_fee: deliveryFee,
      discount,
      ...(fulfillment === "delivery" && address ? { address } : {}),
    };

    // Envia ao CW
    let cwResponse = null;
    let cwOrderId = null;
    try {
      cwResponse = await cw.createOrder(cwPayload);
      cwOrderId = cwResponse?.id || cwResponse?.order_id || null;
    } catch (e) {
      console.warn("CW createOrder falhou no painel:", e.message);
    }

    // Salva localmente com idempotência
    const idempotencyKey = randomUUID();
    const { order } = await createWithIdempotency({
      tenantId,
      customerId,
      idempotencyKey,
      items,
      total,
      fulfillment,
      address: address ? normalizeAddress(address).address : null,
      paymentMethodId,
      paymentMethodName,
      deliveryFee,
      discount,
      cwOrderId,
      cwPayload,
      cwResponse,
    });

    res.json({ ok: true, order, cwOrderId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/settings ────────────────────────────────────────
router.get("/settings", authAdmin, async (req, res) => {
  try {
    const tenantId = req.query.tenant || "tenant-pappi-001";
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) return res.status(404).json({ error: "Tenant não encontrado" });

    // Busca lista de atendentes do Config (se existir)
    const cfg = await prisma.config.findUnique({ where: { key: `${tenantId}:attendants` } }).catch(() => null);
    const attendants = cfg?.value ? JSON.parse(cfg.value) : [];

    res.json({
      id: tenant.id,
      name: tenant.name,
      city: tenant.city,
      waPhoneNumberId: tenant.waPhoneNumberId,
      cwBaseUrl: tenant.cwBaseUrl,
      cwStoreId: tenant.cwStoreId,
      active: tenant.active,
      attendants,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /dash/settings ──────────────────────────────────────
router.patch("/settings", authAdmin, async (req, res) => {
  try {
    const tenantId = req.query.tenant || req.body.tenantId || "tenant-pappi-001";
    const { name, city, attendants } = req.body;

    const data = {};
    if (name) data.name = name;
    if (city !== undefined) data.city = city;

    if (Object.keys(data).length) {
      await prisma.tenant.update({ where: { id: tenantId }, data });
      const { invalidateCache } = require("../services/tenant.service");
      invalidateCache(tenantId);
    }

    // Salva lista de atendentes
    if (Array.isArray(attendants)) {
      await prisma.config.upsert({
        where: { key: `${tenantId}:attendants` },
        create: { key: `${tenantId}:attendants`, value: JSON.stringify(attendants) },
        update: { value: JSON.stringify(attendants) },
      });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/debug ───────────────────────────────────────────
router.get("/debug", authAdmin, async (req, res) => {
  try {
    const tenantId = req.query.tenant || "tenant-pappi-001";
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    const recentCustomers = await prisma.customer.findMany({
      where: { tenantId },
      orderBy: { lastInteraction: "desc" },
      take: 5,
      select: { phone: true, name: true, lastInteraction: true },
    });
    res.json({
      tenant: {
        id: tenant?.id,
        name: tenant?.name,
        waPhoneNumberId: tenant?.waPhoneNumberId,
        active: tenant?.active,
      },
      recentCustomers,
      baileysStatus: baileys.getStatus(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/wa-internal/status ─────────────────────────────
router.get("/wa-internal/status", authDash, (_req, res) => {
  res.json(baileys.getStatus());
});

// ── POST /dash/wa-internal/connect ───────────────────────────
router.post("/wa-internal/connect", authAdmin, async (_req, res) => {
  try {
    await baileys.start();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /dash/wa-internal/disconnect ────────────────────────
router.post("/wa-internal/disconnect", authAdmin, (_req, res) => {
  baileys.disconnect();
  res.json({ ok: true });
});

// ── PATCH /dash/wa-internal/numbers ──────────────────────────
router.patch("/wa-internal/numbers", authAdmin, (req, res) => {
  const { numbers } = req.body;
  baileys.setNotifyNumbers(Array.isArray(numbers) ? numbers : []);
  res.json({ ok: true });
});

module.exports = router;
