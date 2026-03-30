const log = require('../lib/logger').child({ service: 'cardapio-double-check' });

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function extractCatalogItems(catalog) {
  const categories = catalog?.categories || catalog?.normalized_categories || catalog?.data?.categories || catalog?.sections || [];
  return categories.flatMap((category) => category?.items || category?.products || []);
}

function buildCatalogIndexes(catalog) {
  const items = extractCatalogItems(catalog);
  const byId = new Map();
  const byName = new Map();

  for (const item of items) {
    const ids = [item?.id, item?.product_id].filter((v) => v != null).map(String);
    for (const id of ids) byId.set(id, item);
    const nameKey = normalizeText(item?.name);
    if (nameKey) byName.set(nameKey, item);
  }

  return { items, byId, byName };
}

function findCatalogItem(indexes, payloadItem) {
  const idCandidates = [payloadItem?.product_id, payloadItem?.id].filter((v) => v != null).map(String);
  for (const id of idCandidates) {
    if (indexes.byId.has(id)) return indexes.byId.get(id);
  }

  const exactName = normalizeText(payloadItem?.name);
  if (exactName && indexes.byName.has(exactName)) return indexes.byName.get(exactName);

  if (!exactName) return null;
  return indexes.items.find((item) => {
    const itemName = normalizeText(item?.name);
    return itemName && (exactName.includes(itemName) || itemName.includes(exactName));
  }) || null;
}

async function validateOrderPayloadAgainstCardapio({ tenantId, payload, getCatalog, getPaymentMethods }) {
  const errors = [];
  const warnings = [];

  if (!payload || typeof payload !== 'object') {
    return { ok: false, errors: ['Payload do pedido inválido.'], warnings };
  }

  const [catalog, paymentMethods] = await Promise.all([
    typeof getCatalog === 'function' ? getCatalog() : null,
    typeof getPaymentMethods === 'function' ? getPaymentMethods() : [],
  ]);

  if (!catalog) errors.push('CardápioWeb não retornou catálogo válido para conferência.');

  const indexes = catalog ? buildCatalogIndexes(catalog) : { items: [], byId: new Map(), byName: new Map() };
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) errors.push('Pedido sem itens.');

  for (const item of items) {
    const catalogItem = findCatalogItem(indexes, item);
    if (!catalogItem) {
      errors.push(`Item não encontrado no CardápioWeb: ${item?.name || item?.product_id || 'sem identificação'}`);
      continue;
    }

    if (item?.product_id != null && String(item.product_id) !== String(catalogItem.id ?? catalogItem.product_id)) {
      errors.push(`Item ${item?.name || item?.product_id} divergente do catálogo oficial.`);
    }

    const requestedQty = toNumber(item?.quantity);
    if (requestedQty == null || requestedQty <= 0) {
      errors.push(`Quantidade inválida para o item ${item?.name || catalogItem?.name || 'sem nome'}.`);
    }
  }

  const activePaymentIds = new Set((paymentMethods || []).map((method) => toNumber(method?.id)).filter((id) => id != null));
  const payments = Array.isArray(payload.payments) ? payload.payments : [];
  if (!payments.length) warnings.push('Pedido sem bloco payments; valide se o fluxo do CardápioWeb desta loja aceita isso.');

  for (const payment of payments) {
    const requestedId = toNumber(payment?.payment_method_id);
    if (requestedId != null && !activePaymentIds.has(requestedId)) {
      errors.push(`payment_method_id ${payment?.payment_method_id} não está ativo no CardápioWeb.`);
    }
  }

  const totals = payload?.totals || {};
  const totalOrderAmount = toNumber(totals?.order_amount);
  if (totalOrderAmount != null && totalOrderAmount < 0) {
    errors.push('total.order_amount inválido.');
  }

  if (!errors.length) {
    log.info({ tenantId, items: items.length, warnings }, 'CW double-check concluído');
  } else {
    log.warn({ tenantId, errors, warnings }, 'CW double-check encontrou divergências');
  }

  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { validateOrderPayloadAgainstCardapio };
