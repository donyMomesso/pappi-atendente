// src/services/tenant.service.js
// Req 6 — Arquitetura multi-tenant

const prisma = require("../lib/db");
const { createCardapioClient } = require("./cardapio.service");
const { createClient: createWaClient } = require("../lib/whatsapp");

const clientCache = new Map();
const CLIENT_TTL  = 5 * 60 * 1000; // 5 min

async function getTenantByPhoneNumberId(phoneNumberId) {
  return prisma.tenant.findFirst({
    where: { waPhoneNumberId: phoneNumberId, active: true },
  });
}

async function getTenantById(tenantId) {
  return prisma.tenant.findUnique({ where: { id: tenantId } });
}

async function getClients(tenantId) {
  const cached = clientCache.get(tenantId);
  if (cached && Date.now() - cached.loadedAt < CLIENT_TTL) {
    return { cw: cached.cw, wa: cached.wa, config: cached.config };
  }

  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new Error(`Tenant não encontrado: ${tenantId}`);

  const cw = createCardapioClient({
    tenantId:   tenant.id,
    baseUrl:    tenant.cwBaseUrl || "https://integracao.cardapioweb.com",
    apiKey:     tenant.cwApiKey,
    partnerKey: tenant.cwPartnerKey,
    storeId:    tenant.cwStoreId,
  });

  const wa = createWaClient({
    token:         tenant.waToken,
    phoneNumberId: tenant.waPhoneNumberId,
  });

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

module.exports = { getTenantByPhoneNumberId, getTenantById, getClients, invalidateCache, listActive };
