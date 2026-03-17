// src/services/tenant.service.js
// Req 6 — Arquitetura multi-tenant
// Cada tenant tem seu próprio WA token, CW keys, clientes e pedidos.

const { PrismaClient } = require("@prisma/client");
const { createCardapioClient } = require("./cardapio.service");
const { createClient: createWaClient } = require("../lib/whatsapp");

const prisma = new PrismaClient();

// Cache de instâncias por tenant (evita recriar a cada mensagem)
const clientCache = new Map(); // tenantId → { cw, wa, config, loadedAt }
const CLIENT_TTL = 5 * 60 * 1000; // 5 min

/**
 * Busca o tenant pelo phoneNumberId do WhatsApp.
 * Usado no webhook para identificar qual loja recebeu a mensagem.
 *
 * @param {string} phoneNumberId
 * @returns {object|null} tenant row
 */
async function getTenantByPhoneNumberId(phoneNumberId) {
  return prisma.tenant.findFirst({
    where: { waPhoneNumberId: phoneNumberId, active: true },
  });
}

/**
 * Busca o tenant pelo ID.
 */
async function getTenantById(tenantId) {
  return prisma.tenant.findUnique({ where: { id: tenantId } });
}

/**
 * Retorna os clientes CW e WA para um tenant, usando cache.
 *
 * @param {string} tenantId
 * @returns {{ cw, wa, config }}
 */
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

  const wa = createWaClient({
    token: tenant.waToken,
    phoneNumberId: tenant.waPhoneNumberId,
  });

  const entry = { cw, wa, config: tenant, loadedAt: Date.now() };
  clientCache.set(tenantId, entry);

  return { cw, wa, config: tenant };
}

/**
 * Invalida o cache de um tenant (ex: após atualizar configuração).
 */
function invalidateCache(tenantId) {
  clientCache.delete(tenantId);
}

/**
 * Lista todos os tenants ativos.
 */
async function listActive() {
  return prisma.tenant.findMany({ where: { active: true } });
}

module.exports = {
  getTenantByPhoneNumberId,
  getTenantById,
  getClients,
  invalidateCache,
  listActive,
};
