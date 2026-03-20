// src/services/avise-abertura.service.js
// Lista "Me avise quando abrir" — Tarde e Pré-Abertura.
// Limpa após disparo das 18h.

const prisma = require("../lib/db");
const { getClients, listActive } = require("./tenant.service");

const CONFIG_KEY_PREFIX = "avise_abertura:";

function configKey(tenantId) {
  return `${CONFIG_KEY_PREFIX}${tenantId}`;
}

/**
 * Adiciona telefone à lista de aviso na abertura (evita duplicata).
 * @param {string} tenantId
 * @param {string} phone
 * @returns {Promise<boolean>} true se adicionado, false se já estava na lista
 */
async function addToAberturaList(tenantId, phone) {
  const key = configKey(tenantId);
  const normalized = String(phone).replace(/\D/g, "");
  const fullPhone = normalized.startsWith("55") ? normalized : "55" + normalized;

  const cfg = await prisma.config.findUnique({ where: { key } });
  const list = cfg ? JSON.parse(cfg.value) : [];
  if (list.includes(fullPhone)) return false;

  list.push(fullPhone);
  await prisma.config.upsert({
    where: { key },
    create: { key, value: JSON.stringify(list) },
    update: { value: JSON.stringify(list) },
  });
  return true;
}

/**
 * Retorna a lista de telefones que pediram aviso.
 * @param {string} tenantId
 * @returns {Promise<string[]>}
 */
async function getAberturaList(tenantId) {
  const cfg = await prisma.config.findUnique({ where: { key: configKey(tenantId) } });
  return cfg ? JSON.parse(cfg.value) : [];
}

/**
 * Limpa a lista após o disparo.
 * @param {string} tenantId
 */
async function clearAberturaList(tenantId) {
  await prisma.config.upsert({
    where: { key: configKey(tenantId) },
    create: { key: configKey(tenantId), value: "[]" },
    update: { value: "[]" },
  });
}

/**
 * Envia "Estamos Abertos!" para todos da lista e limpa.
 * Chamar às 18h (cron) ou manualmente via POST /admin/avise-abertura
 * @param {string} [tenantId] - se omitido, processa todos os tenants ativos
 * @returns {Promise<{ tenantId: string, sent: number, total: number }[]>}
 */
async function notificarClientesAbertura(tenantId) {
  const tenants = tenantId ? [{ id: tenantId }] : await listActive();
  const results = [];

  for (const t of tenants) {
    const list = await getAberturaList(t.id);
    if (!list.length) {
      results.push({ tenantId: t.id, sent: 0, total: 0 });
      continue;
    }

    let sent = 0;
    try {
      const { cw, wa } = await getClients(t.id);
      const merchant = await cw.getMerchant().catch(() => null);
      const menuUrl = merchant?.url || merchant?.website || merchant?.catalog_url || "";
      const msg = menuUrl
        ? `Ei! Prometido é devido: o forno da Pappi Pizza já está a todo vapor! 🔥🍕\n\nQual vai ser a de hoje? Confira o cardápio: ${menuUrl}`
        : `Ei! Prometido é devido: o forno da Pappi Pizza já está a todo vapor! 🔥🍕\n\nQual vai ser a de hoje? É só mandar seu pedido!`;

      for (const phone of list) {
        try {
          const to = String(phone).replace(/\D/g, "");
          await wa.sendText(to, msg);
          sent++;
        } catch (err) {
          console.warn(`[AviseAbertura] Erro ao enviar para ${phone}:`, err.message);
        }
      }

      await clearAberturaList(t.id);
    } catch (err) {
      console.error(`[AviseAbertura] Erro tenant ${t.id}:`, err.message);
    }
    results.push({ tenantId: t.id, sent, total: list.length });
  }
  return results;
}

module.exports = {
  addToAberturaList,
  getAberturaList,
  clearAberturaList,
  notificarClientesAbertura,
};
