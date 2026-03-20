// src/services/meta-capi.service.js
// Conversions API (CAPI) da Meta
// Envia eventos de conversão do WhatsApp para o Facebook/Instagram
// Usado para otimizar anúncios de aquisição de novos clientes
//
// Eventos enviados:
//   - Purchase   → quando pedido é confirmado
//   - InitiateCheckout → quando cliente chega na etapa de pagamento
//   - Contact    → quando cliente inicia conversa pela primeira vez

const crypto = require("crypto");
const ENV    = require("../config/env");

const CAPI_URL = "https://graph.facebook.com/v19.0";

// ── Hash SHA256 (exigido pela Meta para PII) ──────────────────
function hash(value) {
  if (!value) return null;
  return crypto
    .createHash("sha256")
    .update(String(value).toLowerCase().trim())
    .digest("hex");
}

// ── Normaliza telefone para formato E.164 sem + ───────────────
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  // Garante DDI 55
  return digits.startsWith("55") ? digits : `55${digits}`;
}

// ── Monta dados do usuário (sempre hasheados) ─────────────────
function buildUserData(customer, ipAddress = null) {
  const phone = normalizePhone(customer.phone);
  return {
    // Telefone hasheado — campo mais importante para matching
    ph: [hash(phone)],
    // Nome hasheado se disponível
    ...(customer.name ? { fn: [hash(customer.name.split(" ")[0])] } : {}),
    // País
    country: [hash("br")],
    // IP do cliente se disponível
    ...(ipAddress ? { client_ip_address: ipAddress } : {}),
    // External ID = ID do customer no banco (não precisa ser hasheado)
    external_id: [hash(customer.id)],
  };
}

// ── Envia evento para a CAPI ──────────────────────────────────
async function sendEvent(events) {
  const pixelId    = ENV.META_PIXEL_ID;
  const accessToken = ENV.META_CAPI_TOKEN;

  if (!pixelId || !accessToken) {
    console.warn("[Meta CAPI] META_PIXEL_ID ou META_CAPI_TOKEN não configurados — evento ignorado");
    return null;
  }

  const url  = `${CAPI_URL}/${pixelId}/events?access_token=${accessToken}`;
  const body = {
    data: events,
    // test_event_code: ENV.META_CAPI_TEST_CODE || undefined, // descomente para testar
  };

  try {
    const resp = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error("[Meta CAPI] Erro ao enviar evento:", JSON.stringify(data));
      return null;
    }

    console.log(`[Meta CAPI] ✅ ${events.length} evento(s) enviado(s) — events_received: ${data.events_received}`);
    return data;
  } catch (err) {
    console.error("[Meta CAPI] Falha na requisição:", err.message);
    return null;
  }
}

// ── EVENTO: Purchase ──────────────────────────────────────────
// Disparado quando o pedido é confirmado com sucesso
async function trackPurchase({ customer, order, items }) {
  const eventTime = Math.floor(Date.now() / 1000);

  // Monta conteúdo do pedido (itens)
  const contents = (items || []).map(i => ({
    id:         String(i.id || i.name),
    quantity:   i.quantity || 1,
    item_price: i.unit_price || 0,
    title:      i.name,
  }));

  const event = {
    event_name:        "Purchase",
    event_time:        eventTime,
    action_source:     "other", // WhatsApp não é web nem app
    event_source_url:  `https://wa.me/${normalizePhone(customer.phone)}`,
    user_data:         buildUserData(customer),
    custom_data: {
      currency:    "BRL",
      value:       order.total,
      contents,
      content_type: "product",
      order_id:    order.id,
      // Canal de origem — útil para segmentação
      custom_properties: {
        channel:     "whatsapp",
        fulfillment: order.fulfillment, // delivery ou takeout
      },
    },
  };

  return sendEvent([event]);
}

// ── EVENTO: InitiateCheckout ───────────────────────────────────
// Disparado quando cliente chega na etapa de pagamento
async function trackInitiateCheckout({ customer, cart, deliveryFee = 0 }) {
  const total    = cart.reduce((s, i) => s + (i.unit_price * i.quantity), 0) + deliveryFee;
  const eventTime = Math.floor(Date.now() / 1000);

  const contents = cart.map(i => ({
    id:         String(i.id || i.name),
    quantity:   i.quantity || 1,
    item_price: i.unit_price || 0,
    title:      i.name,
  }));

  const event = {
    event_name:    "InitiateCheckout",
    event_time:    eventTime,
    action_source: "other",
    user_data:     buildUserData(customer),
    custom_data: {
      currency:     "BRL",
      value:        total,
      contents,
      content_type: "product",
      num_items:    cart.reduce((s, i) => s + i.quantity, 0),
    },
  };

  return sendEvent([event]);
}

// ── EVENTO: Contact ───────────────────────────────────────────
// Disparado na primeira interação do cliente (lead novo)
async function trackContact({ customer }) {
  // Só envia se for a primeira vez (visitCount === 0)
  if ((customer.visitCount || 0) > 0) return null;

  const event = {
    event_name:    "Contact",
    event_time:    Math.floor(Date.now() / 1000),
    action_source: "other",
    user_data:     buildUserData(customer),
    custom_data: {
      channel: "whatsapp",
    },
  };

  return sendEvent([event]);
}

// ── EVENTO: ViewContent ───────────────────────────────────────
// Disparado quando cliente pede o cardápio
async function trackViewContent({ customer, tenantName }) {
  const event = {
    event_name:    "ViewContent",
    event_time:    Math.floor(Date.now() / 1000),
    action_source: "other",
    user_data:     buildUserData(customer),
    custom_data: {
      content_type: "product",
      content_name: `Cardápio ${tenantName || ""}`.trim(),
      channel:      "whatsapp",
    },
  };

  return sendEvent([event]);
}

module.exports = { trackPurchase, trackInitiateCheckout, trackContact, trackViewContent };