// src/services/tenant.service.js
// Req 6 — Arquitetura multi-tenant

const prisma = require("../lib/db");
const log = require("../lib/logger").child({ service: "tenant" });
const { createCardapioClient } = require("./cardapio.service");
const { createClient: createWaClient } = require("../lib/whatsapp");

const clientCache = new Map();
const CLIENT_TTL = 5 * 60 * 1000; // 5 min

/** Meta às vezes manda phone_number_id como número JSON; no banco costuma ser string. */
function normalizeWaPhoneNumberId(phoneNumberId) {
  if (phoneNumberId == null) return "";
  return String(phoneNumberId).replace(/\s+/g, "").trim();
}

async function getTenantByPhoneNumberId(phoneNumberId) {
  const id = normalizeWaPhoneNumberId(phoneNumberId);
  if (!id) return null;
  return prisma.tenant.findFirst({
    where: { waPhoneNumberId: id, active: true },
  });
}

async function getTenantById(tenantId) {
  return prisma.tenant.findUnique({ where: { id: tenantId } });
}

/** Cliente Cloud API inerte: não quebra getClients quando só Baileys/CW está em uso. */
function createDisabledWaClient(tenantId, reason) {
  const fail = async (op) => {
    const e = new Error(`WhatsApp Cloud API indisponível (tenant ${tenantId}): ${reason}. Operação: ${op}`);
    e.code = "WA_CLOUD_NOT_CONFIGURED";
    throw e;
  };
  return {
    sendText: () => fail("sendText"),
    sendButtons: () => fail("sendButtons"),
    sendList: () => fail("sendList"),
    sendTemplate: () => fail("sendTemplate"),
    markRead: async () => {},
    getTemplates: async () => [],
    getMediaUrl: async () => null,
    sendImage: () => fail("sendImage"),
    sendAudio: () => fail("sendAudio"),
    sendDocument: () => fail("sendDocument"),
  };
}

async function getClients(tenantId) {
  const cached = clientCache.get(tenantId);
  if (cached && Date.now() - cached.loadedAt < CLIENT_TTL) {
    return { cw: cached.cw, wa: cached.wa, config: cached.config };
  }

  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new Error(`Tenant não encontrado: ${tenantId}`);

  const cw = createCardapioClient({
    tenantId: tenant.id,
    baseUrl: tenant.cwBaseUrl || "https://integracao.cardapioweb.com",
    apiKey: tenant.cwApiKey,
    partnerKey: tenant.cwPartnerKey,
    storeId: tenant.cwStoreId,
  });

  const token = (tenant.waToken || "").trim();
  const phoneNumberId = (tenant.waPhoneNumberId || "").trim();
  const wa =
    token && phoneNumberId
      ? createWaClient({ token, phoneNumberId })
      : createDisabledWaClient(
          tenant.id,
          !token && !phoneNumberId
            ? "waToken e waPhoneNumberId ausentes"
            : !token
              ? "waToken ausente"
              : "waPhoneNumberId ausente",
        );

  if (!token || !phoneNumberId) {
    log.warn(
      { tenantId: tenant.id, name: tenant.name, hasToken: !!token, hasPhoneNumberId: !!phoneNumberId },
      "WhatsApp Cloud API incompleto — envio pela API desabilitado (Baileys/outros canais seguem)",
    );
  }

  const entry = { cw, wa, config: tenant, loadedAt: Date.now() };
  clientCache.set(tenantId, entry);

  return { cw, wa, config: tenant };
}

function invalidateCache(tenantId) {
  clientCache.delete(tenantId);
}

async function listActive() {
  return prisma.tenant.findMany({ where: { active: true } });
}

module.exports = {
  getTenantByPhoneNumberId,
  normalizeWaPhoneNumberId,
  getTenantById,
  getClients,
  invalidateCache,
  listActive,
};
