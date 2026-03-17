// src/routes/dashboard.routes.js
const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { requireAttendantKey } = require("../middleware/auth.middleware");
const { setHandoff } = require("../services/customer.service");
const { getClients } = require("../services/tenant.service");
const { createWithIdempotency } = require("../services/order.service");
const { validate: validateTotal } = require("../calculators/OrderCalculator");
const { map: mapPayment } = require("../mappers/PaymentMapper");
const { normalize: normalizeAddress } = require("../normalizers/AddressNormalizer");
const PhoneNormalizer = require("../normalizers/PhoneNormalizer");
const { randomUUID } = require("crypto");

const prisma = new PrismaClient();
const router = express.Router();

// ── Autenticação simples via query param (para o painel HTML) ──
function authDash(req, res, next) {
  const key = req.headers["x-api-key"]
    || req.query.key
    || req.headers["authorization"]?.replace("Bearer ", "");
  const ENV = require("../config/env");
  if (!ENV.ATTENDANT_API_KEY || key !== ENV.ATTENDANT_API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

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
        addons: i.addons || [],
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

module.exports = router;
