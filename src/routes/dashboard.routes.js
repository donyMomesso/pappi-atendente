const express = require("express");
const { authAdmin, authDash } = require("../middleware/auth.middleware");
const { getClients } = require("../services/tenant.service");
const googleContacts = require("../services/google-contacts.service");
const baileys = require("../services/baileys.service");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const retention = require("../services/retention.service");

const router = express.Router();

// ── GET /dash/login ───────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { tenant } = req.query;
    const attendantKey = req.headers["x-attendant-key"];

    if (!tenant || !attendantKey) {
      return res.status(400).json({ error: "Tenant ID e Attendant Key são obrigatórios" });
    }

    const config = await prisma.tenant.findUnique({ where: { id: tenant } });
    if (!config) {
      return res.status(404).json({ error: "Tenant não encontrado" });
    }

    const attendantsConfig = await prisma.config.findUnique({
      where: { key: `${tenant}:attendants` },
    });
    const attendants = attendantsConfig ? JSON.parse(attendantsConfig.value) : [];

    const attendant = attendants.find(att => att.key === attendantKey);

    if (!attendant) {
      return res.status(401).json({ error: "Chave de atendente inválida" });
    }

    res.json({ name: attendant.name, role: attendant.role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/settings ────────────────────────────────────────
router.get("/settings", authAdmin, async (req, res) => {
  try {
    const tenantId = req.query.tenant || "tenant-pappi-001";
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });

    const attendantsConfig = await prisma.config.findUnique({
      where: { key: `${tenantId}:attendants` },
    });
    const attendants = attendantsConfig ? JSON.parse(attendantsConfig.value) : [];

    const googleUsersConfig = await prisma.config.findUnique({
      where: { key: `${tenantId}:google_users` },
    });
    const googleUsers = googleUsersConfig ? JSON.parse(googleUsersConfig.value) : [];

    res.json({
      id: tenant.id,
      name: tenant.name,
      city: tenant.city,
      waPhoneNumberId: tenant.waPhoneNumberId,
      cwBaseUrl: tenant.cwBaseUrl,
      cwStoreId: tenant.cwStoreId,
      active: tenant.active,
      attendants,
      googleUsers,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /dash/settings ──────────────────────────────────────
router.patch("/settings", authAdmin, async (req, res) => {
  try {
    const tenantId = req.query.tenant || req.body.tenantId || "tenant-pappi-001";
    const { name, city, attendants, googleUsers } = req.body;

    const data = {};
    if (name) data.name = name;
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
      baileysStatus: baileys.getAllStatuses(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/google-contacts/auth-url ───────────────────────
router.get("/google-contacts/auth-url", authAdmin, (_req, res) => {
  res.json({ url: googleContacts.getAuthUrl() });
});

// ── GET /dash/google-contacts/callback ───────────────────────
router.get("/google-contacts/callback", async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send("Código ausente.");
    const tokens = await googleContacts.exchangeCode(code);
    await googleContacts.saveTokens(tokens);
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>✅ Google Contacts autorizado!</h2>
      <p>Novos clientes serão salvos automaticamente nos seus contatos Google.</p>
      <script>setTimeout(()=>window.close(),3000)</script>
    </body></html>`);
  } catch (err) {
    res.status(500).send("Erro: " + err.message);
  }
});

// ── GET /dash/google-contacts/status ─────────────────────────
router.get("/google-contacts/status", authAdmin, async (_req, res) => {
  res.json({ authorized: await googleContacts.isAuthorized() });
});

// ── POST /dash/google-contacts/disconnect ────────────────────
router.post("/google-contacts/disconnect", authAdmin, async (_req, res) => {
  await googleContacts.disconnect();
  res.json({ ok: true });
});

// ── GET /dash/google-contacts/search ─────────────────────────
router.get("/google-contacts/search", authDash, async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json([]);
  const results = await googleContacts.searchContacts(q);
  res.json(results);
});

// ── GET /dash/messages/:customerId ───────────────────────────
router.get("/messages/:customerId", authDash, async (req, res) => {
  try {
    const chatMemory = require("../services/chat-memory.service");
    const messages = await chatMemory.get(req.params.customerId);
    res.json(messages);
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

// ── GET /dash/whatsapp/templates ─────────────────────────────
router.get("/whatsapp/templates", authDash, async (req, res) => {
  try {
    const tenantId = req.query.tenant || "tenant-pappi-001";
    const { wa } = await getClients(tenantId);
    const templates = await wa.getTemplates();
    res.json(templates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /dash/whatsapp/send-template ─────────────────────────
router.post("/whatsapp/send-template", authDash, async (req, res) => {
  try {
    const { phone, templateName, languageCode, components, tenantId = "tenant-pappi-001" } = req.body;
    if (!phone || !templateName) return res.status(400).json({ error: "phone e templateName obrigatórios" });

    const { wa } = await getClients(tenantId);
    const result = await wa.sendTemplate(phone, templateName, languageCode || "pt_BR", components || []);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /dash/retention/campaigns ────────────────────────────
router.get("/retention/campaigns", authAdmin, async (req, res) => {
  try {
    const tenantId = req.query.tenant || "tenant-pappi-001";
    const campaigns = await prisma.retentionCampaign.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });
    res.json(campaigns);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /dash/retention/campaigns ───────────────────────────
router.post("/retention/campaigns", authAdmin, async (req, res) => {
  try {
    const tenantId = req.query.tenant || req.body.tenantId || "tenant-pappi-001";
    const { name, message, delayHours = 20, monthlyLimit = 100, aiFilter = true } = req.body;
    if (!name || !message) return res.status(400).json({ error: "name e message obrigatórios" });

    const campaign = await prisma.retentionCampaign.create({
      data: { tenantId, name, message, delayHours: +delayHours, monthlyLimit: +monthlyLimit, aiFilter: !!aiFilter },
    });
    res.json(campaign);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATCH /dash/retention/campaigns/:id ──────────────────────
router.patch("/retention/campaigns/:id", authAdmin, async (req, res) => {
  try {
    const { name, message, delayHours, monthlyLimit, aiFilter, active } = req.body;
    const data = {};
    if (name         !== undefined) data.name         = name;
    if (message      !== undefined) data.message      = message;
    if (delayHours   !== undefined) data.delayHours   = +delayHours;
    if (monthlyLimit !== undefined) data.monthlyLimit = +monthlyLimit;
    if (aiFilter     !== undefined) data.aiFilter     = !!aiFilter;
    if (active       !== undefined) data.active       = !!active;

    const campaign = await prisma.retentionCampaign.update({
      where: { id: req.params.id },
      data,
    });
    res.json(campaign);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DELETE /dash/retention/campaigns/:id ─────────────────────
router.delete("/retention/campaigns/:id", authAdmin, async (req, res) => {
  try {
    await prisma.retentionCampaign.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /dash/retention/run ──────────────────────────────────
// Disparo manual (admin)
router.post("/retention/run", authAdmin, async (req, res) => {
  try {
    retention.runAll().catch(err => console.error("[Retention] run manual:", err.message));
    res.json({ ok: true, message: "Campanhas iniciadas em background" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /dash/retention/stats ─────────────────────────────────
router.get("/retention/stats", authAdmin, async (req, res) => {
  try {
    const tenantId = req.query.tenant || "tenant-pappi-001";
    const stats = await retention.getMonthlyStats(tenantId);
    res.json(stats);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /dash/customer/:id/avatar ────────────────────────────
// Tenta buscar foto de perfil via Baileys (WhatsApp interno)
router.get("/customer/:id/avatar", authDash, async (req, res) => {
  try {
    const customer = await prisma.customer.findUnique({
      where: { id: req.params.id },
      select: { phone: true },
    });
    if (!customer) return res.json({ url: null });

    const url = await baileys.getProfilePicture(customer.phone).catch(() => null);
    res.json({ url: url || null });
  } catch { res.json({ url: null }); }
});

// ── GET /dash/wa-internal/status ─────────────────────────────
router.get("/wa-internal/status", authDash, (_req, res) => {
  res.json(baileys.getAllStatuses());
});

// ── POST /dash/wa-internal/connect ───────────────────────────
router.post("/wa-internal/connect", authAdmin, async (req, res) => {
  try {
    const { instanceId = "default" } = req.body;
    await baileys.start(instanceId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /dash/wa-internal/disconnect ────────────────────────
router.post("/wa-internal/disconnect", authAdmin, (req, res) => {
  const { instanceId = "default" } = req.body;
  baileys.disconnect(instanceId);
  res.json({ ok: true });
});

// ── PATCH /dash/wa-internal/numbers ──────────────────────────
router.patch("/wa-internal/numbers", authAdmin, (req, res) => {
  const { numbers, instanceId = "default" } = req.body;
  baileys.setNotifyNumbers(Array.isArray(numbers) ? numbers : [], instanceId);
  res.json({ ok: true });
});

module.exports = router;
