// src/services/order-intake.service.js
// Intake heurístico reforçado para reduzir repetição e pré-preencher o pedido.

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
  const m = t.match(/\b(\d{5})-?(\d{3})\b/);
  return m ? `${m[1]}${m[2]}` : null;
}

function extractAddressHint(t) {
  const cep = extractCep(t);
  const hasStreet = /\b(rua|r\.|avenida|av\.|travessa|tv\.|rodovia|alameda|pra[cç]a)\b/.test(t);
  const hasNumber = /\b(n[ºo]?|numero)\s*\d+\b/.test(t) || /\b\d{1,5}\b/.test(t);
  const hasBairro = /\b(bairro)\b/.test(t);
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
    { re: /\b(broto)\b/, key: "broto" },
    { re: /\b(media|m(e|é)dia)\b/, key: "media" },
    { re: /\b(grande)\b/, key: "grande" },
    { re: /\b(gigante)\b/, key: "gigante" },
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
  if (includesAny(t, ["pizza"])) return "pizza";
  return null;
}

function detectOrderItemsSignal(t) {
  const flavors = ["calabresa","mussarela","muçarela","frango","portuguesa","marguerita","margherita","4 queijos","quatro queijos","pepperoni","bacon","catupiry","chocolate"];
  const drinks = ["coca","guarana","guaraná","fanta","suco","agua","água","refri","refrigerante","2l","lata"];
  const hasHalf = /\b(meia\s+\w+)\b/.test(t) || /\bmeia\s+a\s+meia\b/.test(t);
  const hasQty = /\b(\d+)\s*x?\b/.test(t);
  const hasFlavor = flavors.some((f) => t.includes(f));
  const hasDrink = drinks.some((d) => t.includes(d));
  return hasHalf || hasFlavor || (hasQty && (hasDrink || hasFlavor)) || hasDrink;
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
  const parsed = parseOrderMessage(text);
  const fulfillment = parsed.fulfillment || detectFulfillment(t);
  const productType = detectProductType(t);
  const paymentMethod = parsed.paymentMethod || detectPayment(t);
  const addressHint = extractAddressHint(t);
  const size = pickSizeFromOptions(t, sizeOptions) || parsed.size;
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const notes = [...(parsed.notes || [])];
  const hasItems = items.length > 0 || detectOrderItemsSignal(t);

  const isOrder = parsed.isOrder || hasItems || !!productType || !!size || !!fulfillment;
  const missing = computeMissing({ fulfillment, addressHint, size, hasItems, paymentMethod });

  const completenessScore = Math.max(0, Math.min(1,
    (Number(hasItems) + Number(!!size) + Number(!!fulfillment) + Number(fulfillment !== "delivery" || !!addressHint) + Number(!!paymentMethod)) / 5,
  ));
  const hasCompleteOrder = isOrder && missing.length === 0;
  const confidence = isOrder ? 0.78 + completenessScore * 0.2 : 0.3;

  if (/\bcom\s+\w+/.test(t)) notes.push("addon_hint");
  if (/\bobs\b|\bobserva(c|ç)(a|ã)o\b|\bobservacao\b/.test(t)) notes.push("notes_present");

  return {
    isOrder,
    confidence: Math.min(0.99, confidence),
    hasCompleteOrder,
    completenessScore,
    items,
    hasItems,
    productType,
    size,
    fulfillment,
    address: addressHint ? { ...addressHint, raw: text } : null,
    paymentMethod,
    notes: Array.from(new Set(notes)),
    missing,
  };
}

module.exports = { intake };
