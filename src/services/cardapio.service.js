// src/services/cardapio.service.js

const { withRetry } = require("../lib/retry");
const { setMethods } = require("../mappers/PaymentMapper");
const log = require("../lib/logger").child({ service: "cardapio" });
const { validateOrderPayloadAgainstCardapio } = require("./cardapio-double-check.service");

const TIMEOUT_MS = 15000;
const catalogCache = new Map();
const CATALOG_TTL = 5 * 60 * 1000;

function normalizeCatalogResponse(data) {
  if (!data || typeof data !== "object") return data;
  const categories = Array.isArray(data.categories)
    ? data.categories
    : Array.isArray(data?.data?.categories)
      ? data.data.categories
      : Array.isArray(data.sections)
        ? data.sections
        : [];
  const normalizedCategories = categories.map((cat, idx) => {
    const products = Array.isArray(cat?.products)
      ? cat.products
      : Array.isArray(cat?.items)
        ? cat.items
        : [];
    return {
      ...cat,
      id: cat?.id ?? `cat_${idx + 1}`,
      name: cat?.name || cat?.title || cat?.category || `Categoria ${idx + 1}`,
      products,
      items: products,
    };
  });
  const flatItems = normalizedCategories.flatMap((cat) =>
    (cat.products || []).map((item) => ({
      ...item,
      _categoryId: cat.id,
      _categoryName: cat.name,
    })),
  );
  const productIndexById = Object.fromEntries(
    flatItems
      .filter((item) => item?.id != null || item?.product_id != null)
      .map((item) => [String(item.id ?? item.product_id), item]),
  );
  return {
    ...data,
    categories: normalizedCategories,
    normalized_categories: normalizedCategories,
    flat_items: flatItems,
    product_index_by_id: productIndexById,
  };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function safeJson(resp) {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

function createCardapioClient({ tenantId, baseUrl, apiKey, partnerKey, storeId: _storeId }) {
  const base = (baseUrl || "https://integracao.cardapioweb.com").replace(/\/$/, "");
  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  function headersPartner() {
    if (!apiKey) throw new Error(`[${tenantId}] CARDAPIOWEB_API_KEY não configurado`);
    if (!partnerKey) throw new Error(`[${tenantId}] CARDAPIOWEB_PARTNER_KEY não configurado`);
    return {
      "X-API-KEY": apiKey,
      "X-PARTNER-KEY": partnerKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  function headersApiKey() {
    if (!apiKey) throw new Error(`[${tenantId}] CARDAPIOWEB_API_KEY não configurado`);
    return { "X-API-KEY": apiKey, Accept: "application/json" };
  }

  async function getMerchant() {
    return withRetry(
      async () => {
        const resp = await fetchWithTimeout(`${base}/api/partner/v1/merchant`, { headers: headersPartner() });
        const data = await safeJson(resp);
        if (!resp.ok || !data) return null;
        return data;
      },
      { maxAttempts: 2, label: `CW:${tenantId}:getMerchant` },
    ).catch(() => null);
  }

  async function getCatalog() {
    const cached = catalogCache.get(tenantId);
    if (cached?.catalog && Date.now() - (cached.catalogFetchedAt || 0) < CATALOG_TTL) return cached.catalog;

    const attempts = [
      () => fetchWithTimeout(`${base}/api/partner/v1/catalog`, { headers: headersPartner() }),
      () => fetchWithTimeout(`${base}/api/partner/v1/catalog`, { headers: headersApiKey() }),
    ];

    let data = null;
    for (const attempt of attempts) {
      try {
        const resp = await withRetry(attempt, { maxAttempts: 3, label: `CW:${tenantId}:catalog` });
        if (resp.ok) {
          data = normalizeCatalogResponse(await safeJson(resp));
          if (data) break;
        } else {
          const body = await safeJson(resp).catch(() => null);
          log.warn({ tenantId, status: resp.status, body }, "CW getCatalog: HTTP não-OK");
        }
      } catch (err) {
        log.warn({ tenantId, err: err.message }, "CW getCatalog: exceção na tentativa");
      }
    }

    if (!data) {
      const stale = catalogCache.get(tenantId);
      if (stale?.catalog) {
        log.warn({ tenantId }, "CW catalog indisponível, usando cache expirado");
        return stale.catalog;
      }
      log.error({ tenantId }, "CW getCatalog: retornou null (sem cache) — pedidos ficam sem preço");
      return null;
    }

    const entry = catalogCache.get(tenantId) || {};
    catalogCache.set(tenantId, { ...entry, catalog: data, catalogFetchedAt: Date.now() });
    return data;
  }

  async function getPaymentMethods() {
    const cached = catalogCache.get(tenantId);
    if (cached?.paymentMethods && Date.now() - (cached.paymentMethodsFetchedAt || 0) < CATALOG_TTL) return cached.paymentMethods;

    try {
      const resp = await withRetry(
        () => fetchWithTimeout(`${base}/api/partner/v1/merchant/payment_methods`, { headers: headersPartner() }),
        { maxAttempts: 2, label: `CW:${tenantId}:paymentMethods` },
      );
      const data = await safeJson(resp);
      const methods = Array.isArray(data) ? data : data?.data || [];
      setMethods(tenantId, methods);
      const entry = catalogCache.get(tenantId) || {};
      catalogCache.set(tenantId, { ...entry, paymentMethods: methods, paymentMethodsFetchedAt: Date.now() });
      return methods;
    } catch {
      return catalogCache.get(tenantId)?.paymentMethods || [];
    }
  }

  async function createOrder(payload) {
    if (!payload || typeof payload !== "object")
      throw Object.assign(new Error("createOrder: payload inválido"), { status: 400 });

    // Duplo check: catálogo + meios de pagamento ativos antes do POST final.
    const validation = await validateOrderPayloadAgainstCardapio({
      tenantId,
      payload,
      getCatalog,
      getPaymentMethods,
    });
    if (!validation.ok) {
      const err = new Error(`CW double-check falhou: ${validation.errors.join(" | ")}`);
      err.status = 422;
      err.data = { errors: validation.errors, warnings: validation.warnings };
      throw err;
    }

    // Regra CW: payment_method_id deve estar ativo no estabelecimento.
    const paymentMethods = await getPaymentMethods();
    const paymentIds = new Set((paymentMethods || []).map((m) => toNum(m?.id)).filter((n) => n != null));
    const reqPayments = Array.isArray(payload?.payments) ? payload.payments : [];
    if (!paymentMethods?.length) {
      const err = new Error(
        "CardápioWeb sem métodos de pagamento ativos para esta loja. Ative pagamentos no Portal CW e tente novamente.",
      );
      err.status = 422;
      err.data = { errors: ["Payments list is empty for this merchant"] };
      throw err;
    }
    for (const p of reqPayments) {
      const reqId = toNum(p?.payment_method_id);
      if (reqId != null && !paymentIds.has(reqId)) {
        const err = new Error(
          `payment_method_id ${p?.payment_method_id} não está ativo no CardápioWeb para este estabelecimento.`,
        );
        err.status = 422;
        err.data = { errors: [`payment_method_id ${p?.payment_method_id} not found or inactive`] };
        throw err;
      }
    }

    return withRetry(
      async () => {
        const resp = await fetchWithTimeout(`${base}/api/partner/v1/orders`, {
          method: "POST",
          headers: headersPartner(),
          body: JSON.stringify(payload),
        });
        const data = await safeJson(resp);
        if (!resp.ok) {
          let msg = Array.isArray(data?.errors) ? data.errors.join(" | ") : JSON.stringify(data);
          const code = data?.code;
          if (resp.status === 401) {
            msg =
              "Falha de autenticação no CardápioWeb (X-API-KEY/X-PARTNER-KEY inválidos ou de ambiente diferente: produção vs sandbox).";
            if (code) msg += ` [code=${code}]`;
          }
          const err = new Error(`CW createOrder ${resp.status}: ${msg}`);
          err.status = resp.status;
          err.data = data;
          throw err;
        }
        return data;
      },
      { maxAttempts: 3, baseDelayMs: 1000, label: `CW:${tenantId}:createOrder` },
    );
  }

  async function cancelOrder(cwOrderId, reason = "Solicitado pelo cliente") {
    const resp = await fetchWithTimeout(`${base}/api/partner/v1/orders/${cwOrderId}/cancel`, {
      method: "POST",
      headers: headersApiKey(),
      body: JSON.stringify({ cancellation_reason: reason }),
    });
    if (resp.status === 204 || resp.ok) return { ok: true };
    const data = await safeJson(resp);
    return { ok: false, error: `HTTP ${resp.status}`, data };
  }

  async function changeStatus(cwOrderId, action) {
    const resp = await fetchWithTimeout(`${base}/api/partner/v1/orders/${cwOrderId}/${action}`, {
      method: "POST",
      headers: headersPartner(),
    });
    if (resp.status === 204 || resp.ok) return { ok: true };
    const data = await safeJson(resp);
    return { ok: false, error: `HTTP ${resp.status}`, data };
  }

  async function getDeliveryFee({ lat, lng } = {}) {
    try {
      if (lat == null || lng == null) {
        return {
          delivery_fee: null,
          is_serviceable: null,
          status: "missing_coordinates",
          message: "Coordenadas ausentes para calcular taxa real",
          raw: null,
        };
      }

      const resp = await fetchWithTimeout(`${base}/api/partner/v1/delivery_fee`, {
        method: "POST",
        headers: headersPartner(),
        body: JSON.stringify({ latitude: lat, longitude: lng }),
      });
      const data = await safeJson(resp);
      const fee = parseFloat(
        data?.delivery_fee ?? data?.fee ?? data?.value ?? data?.amount ?? data?.data?.delivery_fee ?? data?.data?.fee,
      );

      return {
        delivery_fee: Number.isFinite(fee) ? fee : null,
        is_serviceable:
          typeof data?.is_serviceable === "boolean"
            ? data.is_serviceable
            : resp.ok
              ? Number.isFinite(fee)
              : false,
        status: data?.status || data?.code || resp.status,
        message: data?.message || data?.detail || data?.error || data?.data?.message || null,
        raw: data,
      };
    } catch (err) {
      return {
        delivery_fee: null,
        is_serviceable: null,
        status: "fee_lookup_error",
        message: err.message,
        raw: null,
      };
    }
  }

  async function getCustomerByPhone(localPhone) {
    try {
      const resp = await fetchWithTimeout(`${base}/api/partner/v1/customers?phone_number=${localPhone}`, {
        headers: headersPartner(),
      });
      const data = await safeJson(resp);
      if (!resp.ok || !data) return null;
      return Array.isArray(data) ? data[0] : (data?.data?.[0] ?? (data?.id ? data : null));
    } catch {
      return null;
    }
  }

  async function getOrderById(cwOrderId) {
    try {
      const resp = await fetchWithTimeout(`${base}/api/partner/v1/orders/${cwOrderId}`, { headers: headersPartner() });
      const data = await safeJson(resp);
      return resp.ok ? data : null;
    } catch {
      return null;
    }
  }

  async function listOrdersByPhone(phone, limit = 30) {
    const normalized = String(phone).replace(/\D/g, "");
    if (!normalized || normalized.length < 10) return [];
    const endpoints = [
      `orders?phone_number=${normalized}&per_page=${limit}`,
      `orders?customer_phone=${normalized}&per_page=${limit}`,
    ];
    for (const ep of endpoints) {
      try {
        const resp = await fetchWithTimeout(`${base}/api/partner/v1/${ep}`, { headers: headersPartner() });
        const data = await safeJson(resp);
        if (!resp.ok) continue;
        const raw = Array.isArray(data) ? data : (data?.data ?? data?.orders ?? []);
        if (Array.isArray(raw) && raw.length > 0) return raw.slice(0, limit);
      } catch {}
    }
    const customer = await getCustomerByPhone(normalized);
    if (customer?.id) {
      try {
        const resp = await fetchWithTimeout(
          `${base}/api/partner/v1/orders?customer_id=${customer.id}&per_page=${limit}`,
          { headers: headersPartner() },
        );
        const data = await safeJson(resp);
        if (resp.ok && data) {
          const raw = Array.isArray(data) ? data : (data?.data ?? data?.orders ?? []);
          return Array.isArray(raw) ? raw.slice(0, limit) : [];
        }
      } catch {}
    }
    return [];
  }

  async function isOpen() {
    const merchant = await getMerchant();
    if (!merchant) return true;
    if (merchant.status && merchant.status !== "ACTIVE") return false;

    const oh = merchant.opening_hours;
    if (!oh) return true;

    const tmpEnd = oh.temporary_state_end_at ? new Date(oh.temporary_state_end_at) : null;
    if (oh.temporary_state === "closed" && tmpEnd && tmpEnd > new Date()) return false;

    const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    const intervals = oh[DAYS[now.getDay()]];
    if (!Array.isArray(intervals) || !intervals.length) return false;

    const toMin = (s) => {
      const [h, m] = String(s).split(":");
      return +h * 60 + +m;
    };
    const cur = now.getHours() * 60 + now.getMinutes();
    return intervals.some(([s, e]) => cur >= toMin(s) && cur < toMin(e));
  }

  /**
   * Solicita ao CW um carrinho pré-preenchido com preços oficiais.
   * POST /api/partner/v1/merchant/prefilled_order
   *
   * Contrato de resposta mínimo garantido:
   *   { link: string, order_amount: number, delivery_fee: number }
   * O array `items` com unit_price pode ou não vir — tratado defensivamente.
   *
   * @param {{ items, fulfillment, address, customerPhone }} opts
   */
  async function createPrefilledOrder({ items, fulfillment, address, customerPhone }) {
    // Resolve IDs de produto a partir do catálogo em cache (sem nova chamada de rede)
    const catalog = await getCatalog();
    const allProducts = (
      catalog?.categories ||
      catalog?.data?.categories ||
      catalog?.sections ||
      (Array.isArray(catalog) ? catalog : [])
    ).flatMap((c) => c.items || c.products || []);

    const normName = (s) =>
      String(s || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim();

    const cwItems = (items || []).map((line) => {
      const linNorm = normName(line.name);
      // Tenta match exato primeiro, depois por prefixo de palavra
      const matched =
        allProducts.find((p) => normName(p.name) === linNorm) ||
        allProducts.find((p) => {
          const pn = normName(p.name);
          return pn.includes(linNorm) || linNorm.includes(pn);
        }) ||
        allProducts.find((p) => {
          const pn = normName(p.name);
          return linNorm.includes(pn.split(" ")[0]) || pn.includes(linNorm.split(" ")[0]);
        });

      const cwItem = {
        name: String(line.name),
        quantity: Math.max(1, parseInt(line.quantity, 10) || 1),
      };
      if (matched?.id) cwItem.product_id = String(matched.id);

      if (Array.isArray(line.addons) && line.addons.length) {
        const groups = matched?.option_groups || [];
        cwItem.options = line.addons.map((a) => {
          const opt = { name: String(a.name), quantity: Math.max(1, a.quantity || 1) };
          // Tenta resolver option_id dentro dos grupos do produto
          for (const g of groups) {
            const found = (g.options || []).find(
              (o) => normName(o.name) === normName(a.name),
            );
            if (found?.id) { opt.option_id = String(found.id); break; }
          }
          return opt;
        });
      }
      return cwItem;
    });

    const rawPhone = String(customerPhone || "").replace(/\D/g, "");
    const phone11 = rawPhone.startsWith("55") ? rawPhone.slice(2) : rawPhone;

    const payload = {
      order_type: fulfillment === "delivery" ? "delivery" : "takeout",
      customer: { phone: phone11.slice(-11).padStart(11, "0") },
      items: cwItems,
    };

    if (fulfillment === "delivery" && address?.street) {
      payload.delivery_address = {
        street: address.street || "",
        number: String(address.number || ""),
        neighborhood: address.neighborhood || "",
        city: address.city || "",
        state: address.state || "SP",
        postal_code: (address.zipCode || "").replace(/\D/g, "").slice(0, 8),
      };
      if (Number.isFinite(address.lat) && Number.isFinite(address.lng)) {
        payload.delivery_address.coordinates = {
          latitude: address.lat,
          longitude: address.lng,
        };
      }
    }

    return withRetry(
      async () => {
        const resp = await fetchWithTimeout(
          `${base}/api/partner/v1/merchant/prefilled_order`,
          { method: "POST", headers: headersPartner(), body: JSON.stringify(payload) },
        );
        const data = await safeJson(resp);
        if (!resp.ok) {
          const msg = Array.isArray(data?.errors)
            ? data.errors.join(" | ")
            : JSON.stringify(data);
          const err = new Error(`CW prefilled_order ${resp.status}: ${msg}`);
          err.status = resp.status;
          err.data = data;
          throw err;
        }
        return data;
      },
      { maxAttempts: 2, baseDelayMs: 500, label: `CW:${tenantId}:prefilled_order` },
    );
  }

  return {
    getMerchant,
    getCatalog,
    getPaymentMethods,
    createOrder,
    createPrefilledOrder,
    cancelOrder,
    changeStatus,
    getDeliveryFee,
    getCustomerByPhone,
    getOrderById,
    listOrdersByPhone,
    isOpen,
  };
}

module.exports = { createCardapioClient };
