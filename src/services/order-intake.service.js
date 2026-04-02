// src/services/order-intake.service.js
// FASE 2: Intake heurístico (sem IA pesada) para extrair sinais de pedido a partir do texto consolidado.
// Objetivo: pré-preencher sessão e evitar perguntas redundantes. A resolução final de itens continua no fluxo vencedor (AI chatOrder + catálogo CW).

const { parseOrderMessage } = require("./order-parser.service");

function norm(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function includesAny(t, list) {
  return list.some((w) => t.includes(w));
}

function extractCep(t) {
  const m = t.match(/(\d{5})-?(\d{3})/);
  return m ? `${m[1]}${m[2]}` : null;
}

function extractAddressHint(t) {
  const cep = extractCep(t);
  const hasStreet = /(rua|r\.|avenida|av\.|travessa|tv\.|rodovia|alameda|pra[cç]a)/.test(t);
  const hasNumber = /(n[ºo]?|numero)\s*\d+/.test(t) || /\d{1,5}/.test(t);
  const hasBairro = /(bairro)/.test(t);
  if (cep || (hasStreet && hasNumber) || (hasStreet && hasBairro)) {
    return { cep, hasStreet, hasNumber, hasBairro };
  }
  return null;
}

function pickSizeFromOptions(t, sizeOptions = []) {
  if (!Array.isArray(sizeOptions) || !sizeOptions.length) return null;
  const found = sizeOptions.find((s) => t.includes(norm(s)));
  if (found) return found;
  const synonyms = [
    { re: /(broto)/, key: "broto" },
    { re: /(media|m(e|é)dia)/, key: "media" },
    { re: /(grande|gigante)/, key: "grande" },
  ];
  for (const syn of synonyms) {
    if (!syn.re.test(t)) continue;
    const opt = sizeOptions.find((s) => norm(s).includes(syn.key));
    if (opt) return opt;
  }
  return null;
}

function detectPayment(t) {
  if (includesAny(t, ["pix", "chave pix"])) return "pix";
  if (includesAny(t, ["cartao", "cartao de credito", "credito", "debito", "maquininha"])) return "card";
  if (includesAny(t, ["dinheiro", "troco"])) return "cash";
  return null;
}

function detectFulfillment(t) {
  const isDelivery = includesAny(t, ["entrega", "deliver", "entregar", "motoboy"]);
  const isTakeout = includesAny(t, ["retirada", "retirar", "buscar", "vou buscar", "pegar ai", "pego ai"]);
  if (isDelivery && !isTakeout) return "delivery";
  if (isTakeout && !isDelivery) return "takeout";
  return null;
}

function detectProductType(t) {
  if (includesAny(t, ["lasanha"])) return "lasanha";
  if (includesAny(t, ["pizza", "meia", "calabresa", "mussarela", "portuguesa", "frango", "bacon"])) return "pizza";
  return null;
}

function detectOrderItemsSignal(t) {
  const parsed = parseOrderMessage(t);
  if (parsed?.hasItems) return true;
  const drinks = ["coca", "guarana", "guaraná", "fanta", "suco", "agua", "água", "refri", "refrigerante", "2l", "lata"];
  return drinks.some((d) => t.includes(d));
}

function computeMissing({ fulfillment, addressHint, size, hasItems, paymentMethod }) {
  const missing = [];
  if (!hasItems) missing.push("items");
  if (!size) missing.push("size");
  if (!fulfillment) missing.push("fulfillment");
  if (fulfillment === "delivery") {
    if (!addressHint) missing.push("address");
    else if (addressHint.cep && (!addressHint.hasStreet || !addressHint.hasNumber)) missing.push("address_details");
  }
  if (!paymentMethod) missing.push("payment");
  return missing;
}

function intake({ text, sizeOptions = [] } = {}) {
  const t = norm(text);
  const parsed = parseOrderMessage(t);
  const fulfillment = parsed?.fulfillment || detectFulfillment(t);
  const productType = detectProductType(t);
  const paymentMethod = parsed?.paymentMethod || detectPayment(t);
  const addressHint = extractAddressHint(t);
  const size = pickSizeFromOptions(t, sizeOptions) || parsed?.size || null;
  const hasItems = parsed?.hasItems || detectOrderItemsSignal(t);

  const isOrder = hasItems || !!productType || !!size || !!fulfillment;
  const missing = computeMissing({ fulfillment, addressHint, size, hasItems, paymentMethod });
  const completenessScore = Math.max(
    0,
    Math.min(
      1,
      (Number(hasItems) + Number(!!size) + Number(!!fulfillment) + Number(fulfillment !== "delivery" || !!addressHint) + Number(!!paymentMethod)) / 5,
    ),
  );
  const hasCompleteOrder = isOrder && missing.length === 0;
  const confidence = isOrder ? 0.75 + completenessScore * 0.2 : 0.3;

  const notes = [];
  if (/sem\s+\w+/.test(t)) notes.push("removal_hint");
  if (/com\s+\w+/.test(t)) notes.push("addon_hint");
  if (/obs|observa(c|ç)(a|ã)o|observacao/.test(t)) notes.push("notes_present");

  return {
    isOrder,
    confidence: Math.min(0.99, confidence),
    hasCompleteOrder,
    completenessScore,
    hasItems,
    items: parsed?.items || [],
    productType,
    size,
    fulfillment,
    address: addressHint ? { ...addressHint, raw: text } : null,
    paymentMethod,
    notes,
    missing,
  };
}

module.exports = { intake };
