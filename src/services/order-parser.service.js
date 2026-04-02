// src/services/order-parser.service.js

function norm(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s/+-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const FLAVOR_SYNONYMS = {
  calab: "calabresa",
  calabreza: "calabresa",
  calabresa: "calabresa",
  mussarela: "mussarela",
  muzzarela: "mussarela",
  mucarela: "mussarela",
  mozarela: "mussarela",
  mozzarella: "mussarela",
  marguerita: "marguerita",
  margherita: "marguerita",
  margarita: "marguerita",
  moda: "moda da casa",
  pepperoni: "pepperoni",
  peperoni: "pepperoni",
  "frango com catupiry": "frango com catupiry",
  "frango catupiry": "frango com catupiry",
  "frango com cream cheese": "frango com catupiry",
  "frango cream cheese": "frango com catupiry",
  "frango c catupiry": "frango com catupiry",
  portuguesa: "portuguesa",
  bacon: "bacon",
  chocolate: "chocolate",
  "quatro queijos": "4 queijos",
  "4 queijos": "4 queijos",
  "moda da casa": "moda da casa",
  frango: "frango com catupiry",
};

const SIZE_ALIASES = [
  { re: /\b(broto|brotinho|pequena|mini|4 peda[cç]os?|4 fatias?)\b/, value: "broto" },
  { re: /\b(media|m[eé]dia)\b/, value: "media" },
  { re: /\b(grande|8 peda[cç]os?|8 fatias?)\b/, value: "grande" },
  { re: /\b(gigante|16 peda[cç]os?|16 fatias?|familia|fam[ií]lia)\b/, value: "gigante" },
];

const PAYMENT_ALIASES = [
  { re: /\b(pix)\b/, value: "pix" },
  { re: /\b(cart[aã]o|credito|cr[eé]dito|debito|d[eé]bito|maquininha)\b/, value: "card" },
  { re: /\b(dinheiro|troco)\b/, value: "cash" },
];

function detectFulfillment(t) {
  if (/\b(retirada|retirar|buscar|vou buscar|pego ai|pegar ai|balcao|balc[aã]o)\b/.test(t)) return "takeout";
  if (/\b(entrega|entregar|delivery|motoboy)\b/.test(t)) return "delivery";
  return null;
}

function detectPayment(t) {
  for (const item of PAYMENT_ALIASES) {
    if (item.re.test(t)) return item.value;
  }
  return null;
}

function detectSize(t) {
  for (const item of SIZE_ALIASES) {
    if (item.re.test(t)) return item.value;
  }
  return null;
}

function canonicalFlavor(raw) {
  const v = norm(raw);
  if (!v) return null;
  if (FLAVOR_SYNONYMS[v]) return FLAVOR_SYNONYMS[v];
  for (const [key, value] of Object.entries(FLAVOR_SYNONYMS)) {
    if (v.includes(key)) return value;
  }
  return raw.trim();
}

function detectQuantityNearFlavor(t) {
  const explicit = t.match(/(?:^|\s)(\d{1,2})\s*x\s*(pizza|pizzas?)?\b/i);
  if (explicit) return Math.max(1, Number(explicit[1]) || 1);
  const start = t.match(/^\s*(\d{1,2})\s+(pizza|pizzas?)\b/i);
  if (start) return Math.max(1, Number(start[1]) || 1);
  return 1;
}

function extractHalfAndHalf(t) {
  const patterns = [
    /(?:meia|1\/2|½)\s+([a-z0-9\s]+?)\s+(?:meia|1\/2|½)\s+([a-z0-9\s]+)/i,
    /(?:meia|1\/2|½)\s+([a-z0-9\s]+?)\s*\/\s*(?:meia|1\/2|½)?\s*([a-z0-9\s]+)/i,
  ];

  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const left = canonicalFlavor(m[1]);
      const right = canonicalFlavor(m[2]);
      if (left && right) return [left, right];
    }
  }
  return null;
}

function extractFlavors(t) {
  const hits = new Set();
  for (const key of Object.keys(FLAVOR_SYNONYMS)) {
    if (t.includes(key)) hits.add(FLAVOR_SYNONYMS[key]);
  }
  return Array.from(hits);
}

function extractNotes(t) {
  const notes = [];
  const sem = t.match(/\bsem\s+([a-z0-9\s]+?)(?=\s+(com|e|mais|meia|pix|cartao|dinheiro|retirada|entrega|broto|media|grande|gigante)\b|$)/i);
  if (sem) notes.push(`sem ${sem[1].trim()}`);
  if (/\b(bem passada|assada mais|mais assada)\b/i.test(t)) notes.push("bem passada");
  const borda = t.match(/\b(borda\s+[a-z0-9\s]+)(?=\s+(com|e|mais|pix|cartao|dinheiro|retirada|entrega)\b|$)/i);
  if (borda) notes.push(borda[1].trim());
  return Array.from(new Set(notes));
}

function buildItems(t) {
  const qty = detectQuantityNearFlavor(t);
  const half = extractHalfAndHalf(t);

  if (half) {
    return [{
      name: `½ ${half[0]} / ½ ${half[1]}`,
      quantity: qty,
      notes: [],
      addons: [],
    }];
  }

  const flavors = extractFlavors(t);
  if (!flavors.length) return [];

  return flavors.slice(0, 3).map((name) => ({
    name,
    quantity: qty,
    notes: [],
    addons: [],
  }));
}

function parseOrderMessage(text) {
  const t = norm(text);
  const size = detectSize(t);
  const fulfillment = detectFulfillment(t);
  const paymentMethod = detectPayment(t);
  const notes = extractNotes(t);
  const items = buildItems(t);
  const hasOrderSignal =
    items.length > 0 ||
    !!size ||
    !!fulfillment ||
    /\b(quero|manda|me ve|me vê|vou querer|pedido|pizza|pizzas?)\b/.test(t);

  return {
    isOrder: hasOrderSignal,
    size,
    fulfillment,
    paymentMethod,
    items,
    notes,
    missing: [
      items.length ? null : "items",
      size ? null : "size",
      fulfillment ? null : "fulfillment",
      paymentMethod ? null : "payment",
    ].filter(Boolean),
  };
}

module.exports = { parseOrderMessage, norm };
