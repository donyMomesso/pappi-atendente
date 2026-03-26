// src/services/cardapio.service.js

const { withRetry } = require("../lib/retry");
const { setMethods } = require("../mappers/PaymentMapper");

const TIMEOUT_MS = 15000;
const catalogCache = new Map();
const CATALOG_TTL = 5 * 60 * 1000;

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
    if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL) return cached.catalog;

    const attempts = [
      () => fetchWithTimeout(`${base}/api/partner/v1/catalog`, { headers: headersPartner() }),
      () => fetchWithTimeout(`${base}/api/partner/v1/catalog`, { headers: headersApiKey() }),
    ];

    let data = null;
    for (const attempt of attempts) {
      try {
        const resp = await withRetry(attempt, { maxAttempts: 3, label: `CW:${tenantId}:catalog` });
        if (resp.ok) {
          data = await safeJson(resp);
          if (data) break;
        }
      } catch {}
    }

    if (!data) {
      const stale = catalogCache.get(tenantId);
      if (stale?.catalog) {
        console.warn(`[${tenantId}] CW catalog indisponível, usando cache expirado`);
        return stale.catalog;
      }
      return null;
    }

    const entry = catalogCache.get(tenantId) || {};
    catalogCache.set(tenantId, { ...entry, catalog: data, fetchedAt: Date.now() });
    return data;
  }

  async function getPaymentMethods() {
    const cached = catalogCache.get(tenantId);
    if (cached?.paymentMethods && Date.now() - cached.fetchedAt < CATALOG_TTL) return cached.paymentMethods;

    try {
      const resp = await withRetry(
        () => fetchWithTimeout(`${base}/api/partner/v1/merchant/payment_methods`, { headers: headersPartner() }),
        { maxAttempts: 2, label: `CW:${tenantId}:paymentMethods` },
      );
      const data = await safeJson(resp);
      const methods = Array.isArray(data) ? data : data?.data || [];
      setMethods(tenantId, methods);
      const entry = catalogCache.get(tenantId) || {};
      catalogCache.set(tenantId, { ...entry, paymentMethods: methods, fetchedAt: Date.now() });
      return methods;
    } catch {
      return catalogCache.get(tenantId)?.paymentMethods || [];
    }
  }

  async function createOrder(payload) {
    if (!payload || typeof payload !== "object")
      throw Object.assign(new Error("createOrder: payload inválido"), { status: 400 });

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
      if (lat != null && lng != null) {
        const resp = await fetchWithTimeout(`${base}/api/partner/v1/delivery_fee`, {
          method: "POST",
          headers: headersPartner(),
          body: JSON.stringify({ latitude: lat, longitude: lng }),
        });
        const data = await safeJson(resp);
        if (resp.ok && data != null) {
          const fee = parseFloat(data?.delivery_fee ?? data?.fee ?? data?.value ?? data);
          if (Number.isFinite(fee)) return fee;
        }
      }
      const resp2 = await fetchWithTimeout(`${base}/api/partner/v1/merchant/delivery_areas`, {
        headers: headersPartner(),
      });
      const areas = await safeJson(resp2);
      if (Array.isArray(areas) && areas.length > 0) {
        const fees = areas.map((a) => parseFloat(a.fee ?? a.delivery_fee ?? a.price ?? 0)).filter(Number.isFinite);
        if (fees.length) return Math.min(...fees);
      }
      return null;
    } catch {
      return null;
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

  return {
    getMerchant,
    getCatalog,
    getPaymentMethods,
    createOrder,
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
