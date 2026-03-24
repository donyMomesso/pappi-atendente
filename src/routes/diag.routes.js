// src/routes/diag.routes.js

const express = require("express");
const { requireAdminKey } = require("../middleware/auth.middleware");
const { getClients, listActive, isLikelyPlaceholderWaPhoneNumberId } = require("../services/tenant.service");
const prisma = require("../lib/db");
const messageDbCompat = require("../lib/message-db-compat");
const baileys = require("../services/baileys.service");

const router = express.Router();
const ENV = require("../config/env");
const log = require("../lib/logger").child({ route: "diag" });

const DEFAULT_DIAG_TENANT = "tenant-pappi-001";
const GRAPH = "https://graph.facebook.com/v19.0";

// Debug: verifica se ADMIN_API_KEY está configurada (sem revelar o valor)
router.get("/diag/auth-check", (_req, res) => {
  res.json({
    adminKeyConfigured: !!(ENV.ADMIN_API_KEY && ENV.ADMIN_API_KEY.length > 0),
    hint: ENV.ADMIN_API_KEY
      ? "Chave existe. Use: ?key=SUA_CHAVE ou header x-api-key"
      : "ADMIN_API_KEY não configurada no Render/env",
  });
});

// Status de configuração (sem revelar chaves) — admin ou público para checagem rápida
router.get("/diag/config", (_req, res) => {
  const aiMotor = require("../services/ai-motor.service");
  res.json({
    aiMotor: {
      sequence: aiMotor.getSequence(),
      transcribeSequence: aiMotor.getTranscribeSequence(),
    },
    gemini: {
      configured: !!(ENV.GEMINI_API_KEY && ENV.GEMINI_API_KEY.length > 10),
      model: ENV.GEMINI_MODEL || "gemini-2.5-flash",
    },
    googleMaps: {
      configured: !!(ENV.GOOGLE_MAPS_API_KEY && ENV.GOOGLE_MAPS_API_KEY.length > 10),
      storeCoords: ENV.STORE_LAT != null && ENV.STORE_LNG != null,
    },
  });
});

// Teste de conectividade do Cardápio Web (usado pelo bot para catalog, pedidos, etc.)
router.get("/diag/cw", requireAdminKey, async (req, res) => {
  try {
    const tenants = await listActive();
    if (!tenants.length) {
      return res.json({ ok: false, error: "Nenhum tenant ativo" });
    }
    const tenantId = req.query.tenant || tenants[0].id;
    const { cw, config } = await getClients(tenantId);

    const result = { tenantId, tenantName: config.name, cw: {} };

    const [catalog, merchant, paymentMethods] = await Promise.all([
      cw.getCatalog().catch((e) => ({ error: e.message })),
      cw.getMerchant().catch((e) => ({ error: e.message })),
      cw.getPaymentMethods().catch((e) => ({ error: e.message })),
    ]);

    result.cw.catalog = catalog?.error
      ? { ok: false, error: catalog.error }
      : {
          ok: true,
          categories: catalog?.categories?.length ?? catalog?.data?.categories?.length ?? 0,
          hasData: !!catalog && (!!catalog.categories?.length || !!catalog.data?.categories?.length),
        };
    result.cw.merchant = merchant?.error ? { ok: false, error: merchant.error } : { ok: true };
    result.cw.paymentMethods = paymentMethods?.error
      ? { ok: false, error: paymentMethods.error }
      : { ok: true, count: Array.isArray(paymentMethods) ? paymentMethods.length : 0 };

    result.ok =
      result.cw.catalog.ok && result.cw.merchant.ok && (result.cw.paymentMethods.ok || !paymentMethods?.length);

    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Teste de conectividade das IAs (Gemini + OpenAI fallback)
router.get("/diag/ai", requireAdminKey, async (_req, res) => {
  try {
    const ai = require("../services/ai.service");
    const status = await ai.testAI();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Chamada mínima à Graph (id,username) — validação Meta / App Review.
 *  Use GET /diag/tools/instagram-basic-test se o deploy antigo ainda tiver /diag/:tenantId antes da rota curta. */
async function handleInstagramBasicTest(req, res) {
  const tenantId = String(req.query.tenant || DEFAULT_DIAG_TENANT).trim();

  const rows = await prisma.config.findMany({
    where: {
      key: {
        in: [`${tenantId}:instagram_page_id`, `${tenantId}:facebook_page_token`],
      },
    },
    select: { key: true, value: true },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, (r.value || "").trim()]));
  const instagramPageId =
    map[`${tenantId}:instagram_page_id`] || ENV.INSTAGRAM_PAGE_ID || "";
  const token = map[`${tenantId}:facebook_page_token`] || ENV.FACEBOOK_PAGE_TOKEN || "";

  if (!instagramPageId || !token) {
    log.warn({ tenantId, instagramPageIdPresent: !!instagramPageId, tokenPresent: !!token }, "instagram-basic-test: config ausente");
    return res.status(400).json({
      ok: false,
      tenantId,
      instagramPageId: instagramPageId || null,
      error: "instagram_page_id ou token ausente (Config ou ENV)",
    });
  }

  const url = `${GRAPH}/${encodeURIComponent(instagramPageId)}?fields=id,username`;
  let status;
  let bodyParsed;

  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    status = r.status;
    const raw = await r.text();
    try {
      bodyParsed = raw ? JSON.parse(raw) : null;
    } catch {
      bodyParsed = raw;
    }

    if (r.ok) {
      log.info({ tenantId, instagramPageId, status, ok: true }, "instagram-basic-test: sucesso");
      return res.json({
        ok: true,
        tenantId,
        instagramPageId,
        data: bodyParsed,
      });
    }

    log.error({ tenantId, instagramPageId, status, ok: false }, "instagram-basic-test: falha HTTP");
    return res.status(r.status >= 400 && r.status < 600 ? r.status : 502).json({
      ok: false,
      tenantId,
      instagramPageId,
      status,
      body: bodyParsed,
    });
  } catch (err) {
    log.error({ tenantId, instagramPageId, err: err.message }, "instagram-basic-test: exceção");
    return res.status(500).json({
      ok: false,
      tenantId,
      instagramPageId,
      error: err.message,
    });
  }
}

router.get("/diag/tools/instagram-basic-test", requireAdminKey, handleInstagramBasicTest);
router.get("/diag/instagram-basic-test", requireAdminKey, handleInstagramBasicTest);

router.get("/diag/:tenantId", requireAdminKey, async (req, res) => {
  try {
    const { cw, config } = await getClients(req.params.tenantId);
    const [merchant, paymentMethods] = await Promise.all([
      cw.getMerchant().catch((e) => ({ error: e.message })),
      cw.getPaymentMethods().catch(() => []),
    ]);
    const open = await cw.isOpen().catch(() => null);
    res.json({ tenant: config.name, open, merchant, paymentMethods });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnóstico de roteamento de mensagens
router.get("/diag/routing/check", requireAdminKey, async (_req, res) => {
  try {
    const tenants = await listActive();
    const baileysStatus = await baileys.getAllStatuses();
    const customerCount = await prisma.customer.count();
    const recentMessages = messageDbCompat.isMessagesTableAvailable()
      ? await prisma.message.count({
          where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        })
      : 0;

    const issues = [];

    if (!messageDbCompat.isMessagesTableAvailable()) {
      issues.push(
        'Tabela public.messages ausente — rode prisma migrate deploy ou SQL em prisma/migrations/20260324140000_ensure_public_messages_table/migration.sql',
      );
    }

    if (tenants.length === 0) {
      issues.push("Nenhum tenant ativo — mensagens de todos os canais serão descartadas");
    }

    for (const t of tenants) {
      if (!t.waToken || t.waToken === "dev-token-placeholder") {
        issues.push(`Tenant "${t.name}" tem waToken inválido — Cloud API não funcionará`);
      }
      if (isLikelyPlaceholderWaPhoneNumberId(t.waPhoneNumberId)) {
        issues.push(
          `Tenant "${t.name}" (${t.id}): waPhoneNumberId parece texto-tutorial (ex. SEU_PHONE_NUMBER_ID) — webhooks Cloud API serão ignorados até salvar o Phone number ID da Meta`,
        );
      }
    }

    const connectedBaileys = baileysStatus.filter((s) => s.status === "connected");
    if (connectedBaileys.length === 0 && baileysStatus.length > 0) {
      issues.push("Nenhuma instância Baileys conectada — mensagens QR não serão recebidas");
    }

    res.json({
      tenants: tenants.map((t) => ({ id: t.id, name: t.name, waPhoneNumberId: t.waPhoneNumberId })),
      baileys: baileysStatus,
      stats: { customerCount, recentMessages24h: recentMessages },
      issues: issues.length > 0 ? issues : ["Nenhum problema detectado"],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
