// src/services/order-parser.service.js

function norm(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\s/,+-]/g, " ")
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
  mussa: "mussarela",
  marguerita: "marguerita",
  margherita: "marguerita",
  moda: "moda da casa",
  pepperoni: "pepperoni",
  peperoni: "pepperoni",
  portuguesa: "portuguesa",
  bacon: "bacon",
  chocolate: "chocolate",
  napolitana: "napolitana",
  lombinho: "lombinho",
  estrogonofe: "estrogonofe",
  "quatro queijos": "4 queijos",
  "4 queijos": "4 queijos",
  "frango catupiry": "frango com catupiry",
  "frango com catupiry": "frango com catupiry",
  "frango com cream cheese": "frango com catupiry",
  "frango cream cheese": "frango com catupiry",
  catupiry: "frango com catupiry",
};

const KNOWN_FLAVORS = Array.from(new Set(Object.values(FLAVOR_SYNONYMS)));

const SIZE_ALIASES = [
  { re: /\b(broto|brotinho|4 peda[cç]os?|4 fatias?)\b/, value: "broto" },
  { re: /\b(media|m[eé]dia)\b/, value: "media" },
  { re: /\b(grande|8 peda[cç]os?|8 fatias?)\b/, value: "grande" },
  { re: /\b(gigante|16 peda[cç]os?|16 fatias?)\b/, value: "gigante" },
];

const PAYMENT_ALIASES = [
  { re: /\b(pix)\b/, value: "pix" },
  { re: /\b(cart[aã]o|credito|cr[eé]dito|debito|d[eé]bito|maquininha)\b/, value: "card" },
  { re: /\b(dinheiro|troco)\b/, value: "cash" },
];

function detectFulfillment(t) {
  if (/\b(retirada|retirar|buscar|vou buscar|pego ai|pegar ai)\b/.test(t)) return "takeout";
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

function extractNotes(t) {
  const notes = [];
  const semGlobal = [...t.matchAll(/\bsem\s+([a-z0-9\s]+?)(?=\s+(com|e|mais|meia|pix|cartao|dinheiro|retirada|entrega|outra|uma|1|2|3|4)\b|$)/gi)];
  for (const m of semGlobal) notes.push(`sem ${m[1].trim()}`);
  if (/\b(bem passada|assada mais|mais assada)\b/i.test(t)) notes.push("bem passada");
  return Array.from(new Set(notes));
}

function extractQuantityPrefix(segment) {
  const m = segment.match(/^(\d{1,2})\s*(x)?\s*(pizza|pizzas?)?\b/);
  if (m) return Math.max(1, Number(m[1]) || 1);
  if (/^uma\b/.test(segment)) return 1;
  if (/^duas\b/.test(segment)) return 2;
  if (/^tres\b|^tr[eê]s\b/.test(segment)) return 3;
  return 1;
}

function splitSegments(t) {
  let work = ` ${t} `
    .replace(/\bmais\s+uma\b/g, " | uma ")
    .replace(/\boutra\s+uma\b/g, " | uma ")
    .replace(/\be\s+outra\b/g, " | outra ")
    .replace(/,\s*(?=(?:\d+\s*x?\s*)?(?:pizza|broto|media|m[eé]dia|grande|gigante|uma|outra|meia))/g, " | ")
    .replace(/\b(?=\d+\s*x?\s*(?:pizza|broto|media|m[eé]dia|grande|gigante))/g, " ")
    .replace(/\s+\|\s+/g, "|");

  const raw = work.split("|").map((s) => s.trim()).filter(Boolean);
  if (raw.length > 1) return raw;

  const matches = [];
  const re = /(\d{1,2}\s*x?\s*(?:pizza|pizzas?)?\s*(?:broto|media|m[eé]dia|grande|gigante)?\s*(?:meia\s+[a-z0-9\s]+\s+meia\s+[a-z0-9\s]+|[a-z0-9\s]+?))(?=\s+(?:\d{1,2}\s*x?\s*(?:pizza|pizzas?)?\s*(?:broto|media|m[eé]dia|grande|gigante)|uma\s+(?:broto|media|m[eé]dia|grande|gigante|meia|calabresa|mussarela|portuguesa|bacon|frango)|outra\s+(?:broto|media|m[eé]dia|grande|gigante|meia|calabresa|mussarela|portuguesa|bacon|frango))|$)/gi;
  let m;
  while ((m = re.exec(t))) matches.push(m[1].trim());
  return matches.length ? matches : [t.trim()];
}

function extractHalfAndHalf(segment) {
  const patterns = [
    /(?:meia|1\/2|½)\s+([a-z0-9\s]+?)\s+(?:meia|1\/2|½)\s+([a-z0-9\s]+)/i,
    /(?:meia|1\/2|½)\s+([^/|]+?)\s*\/\s*(?:meia|1\/2|½)?\s*([^/|]+)/i,
  ];
  for (const re of patterns) {
    const m = segment.match(re);
    if (m) {
      const left = canonicalFlavor(m[1]);
      const right = canonicalFlavor(m[2]);
      if (left && right) return [left, right];
    }
  }
  return null;
}

function extractFlavors(segment) {
  const hits = [];
  for (const key of Object.keys(FLAVOR_SYNONYMS)) {
    if (segment.includes(key)) {
      const flavor = FLAVOR_SYNONYMS[key];
      if (!hits.includes(flavor)) hits.push(flavor);
    }
  }
  if (hits.length) return hits;

  const cleaned = segment
    .replace(/\b(uma|outra|mais|quero|pizza|pizzas|broto|media|m[eé]dia|grande|gigante|de|da|do|com|sem|para|retirada|entrega|pix|cartao|dinheiro)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return [];
  return [cleaned];
}

function parseSegment(segment, inheritedSize = null) {
  const seg = norm(segment);
  if (!seg) return null;
  const quantity = extractQuantityPrefix(seg);
  const size = detectSize(seg) || inheritedSize || null;
  const notes = extractNotes(seg);
  const half = extractHalfAndHalf(seg);

  if (half) {
    return {
      quantity,
      size,
      notes,
      items: [{
        name: `½ ${half[0]} / ½ ${half[1]}`,
        quantity,
        size,
        notes: [...notes],
      }],
    };
  }

  const flavors = extractFlavors(seg)
    .map(canonicalFlavor)
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i);

  if (!flavors.length) return null;

  const splitPlural = quantity > 1 && flavors.length > 1 && flavors.length <= quantity;
  const items = splitPlural
    ? flavors.map((name) => ({ name, quantity: 1, size, notes: [...notes] }))
    : [{ name: flavors[0], quantity, size, notes: [...notes] }];

  return { quantity, size, notes, items };
}

function buildItems(t) {
  const segments = splitSegments(t);
  const items = [];
  let inheritedSize = detectSize(t);

  for (const segment of segments) {
    const parsed = parseSegment(segment, inheritedSize);
    if (!parsed?.items?.length) continue;
    if (parsed.size) inheritedSize = parsed.size;
    items.push(...parsed.items);
  }

  if (!items.length) {
    const parsed = parseSegment(t, inheritedSize);
    if (parsed?.items?.length) items.push(...parsed.items);
  }

  return items.map((item) => ({
    ...item,
    notes: Array.isArray(item.notes) ? item.notes : [],
  }));
}

function parseOrderMessage(text) {
  const t = norm(text);
  const detectedSize = detectSize(t);
  const fulfillment = detectFulfillment(t);
  const paymentMethod = detectPayment(t);
  const notes = extractNotes(t);
  const items = buildItems(t);

  const uniqueSizes = Array.from(new Set(items.map((item) => item.size).filter(Boolean)));
  const size = uniqueSizes.length === 1 ? uniqueSizes[0] : (items.length > 1 ? null : detectedSize);

  const hasOrderSignal =
    items.length > 0 ||
    !!detectedSize ||
    !!fulfillment ||
    /\b(quero|manda|me ve|me vê|vou querer|pedido|pizza|pizzas|broto|grande|gigante|media|m[eé]dia)\b/.test(t);

  return {
    isOrder: hasOrderSignal,
    size,
    fulfillment,
    paymentMethod,
    items,
    notes,
    hasItems: items.length > 0,
    itemCount: items.reduce((acc, item) => acc + Math.max(1, Number(item.quantity) || 1), 0),
    missing: [
      items.length ? null : "items",
      size ? null : "size",
      fulfillment ? null : "fulfillment",
      paymentMethod ? null : "payment",
    ].filter(Boolean),
  };
}

module.exports = { parseOrderMessage, norm, KNOWN_FLAVORS };
