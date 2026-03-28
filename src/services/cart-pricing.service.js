// src/services/cart-pricing.service.js
// Recalcula preços do carrinho a partir do catálogo CardápioWeb (nunca confiar em unit_price vindo da IA).

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function catalogCategories(catalog) {
  if (!catalog) return [];
  if (Array.isArray(catalog)) return catalog;
  if (catalog.categories) return catalog.categories;
  if (catalog.data?.categories) return catalog.data.categories;
  if (catalog.sections) return catalog.sections;
  if (catalog.catalog?.categories) return catalog.catalog.categories;
  return [];
}

function listProducts(catalog) {
  const out = [];
  for (const c of catalogCategories(catalog)) {
    for (const item of c.items || c.products || []) {
      if (item.status === "INACTIVE") continue;
      out.push(item);
    }
  }
  return out;
}

function productBasePrice(item) {
  const p = (item.promotional_price_active ? item.promotional_price : null) ?? item.price ?? 0;
  const n = parseFloat(p);
  return Number.isFinite(n) ? n : 0;
}

function isSizeGroupName(groupName) {
  const g = norm(groupName);
  return /\b(tamanho|tamanhos|size|fatia|peda|pedac|broto|media|grande|gigante)\b/.test(g) || /tamanho/.test(g);
}

function scoreLineVsOption(lineName, optionName) {
  const ln = norm(lineName);
  const on = norm(optionName);
  if (!on || !ln) return 0;
  if (ln === on) return 1000;
  if (ln.includes(on) && on.length >= 3) return 200 + Math.min(on.length, 40);
  if (on.includes(ln) && ln.length >= 5) return 150;
  const lw = new Set(ln.split(" ").filter((w) => w.length > 2));
  const ow = on.split(" ").filter((w) => w.length > 2);
  let hit = 0;
  for (const w of ow) if (lw.has(w)) hit++;
  return hit * 30;
}

/**
 * Para uma linha do carrinho (nome vindo da IA), encontra o melhor preço unitário no catálogo.
 * @param {object} line - { name, quantity, unit_price?, addons? }
 * @param {object} catalog
 * @param {{ chosenSize?: string }} ctx
 */
/** Detecta "½ Sabor1 / ½ Sabor2" e retorna [sabor1, sabor2] ou null */
function extractHalfHalf(name) {
  const n = String(name || "");
  // Formatos: "½ Calabresa / ½ Frango", "meia calabresa meia frango", "meia Cala / meia Frango"
  const halfRe = /(?:½|meia?)\s+([^/|]+?)\s*[/|]\s*(?:½|meia?)?\s*([^/|]+)/i;
  const m = n.match(halfRe);
  if (m) return [m[1].trim(), m[2].trim()];
  return null;
}

function priceLineFromCatalog(line, catalog, ctx = {}) {
  const chosenSize = ctx.chosenSize ? norm(ctx.chosenSize) : "";
  const lineName = String(line.name || "");
  const halfFlavors = extractHalfHalf(lineName); // ["Calabresa","Frango"] ou null
  const flavorHint = [lineName, ctx.chosenSize].filter(Boolean).join(" ");
  const products = listProducts(catalog);

  let globalBest = { total: 0, score: -1, productId: null, breakdown: null };

  for (const p of products) {
    const base = productBasePrice(p);
    let bestSize = { price: 0, score: -1 };
    let bestFlavor = { price: 0, score: -1 };
    const groups = p.option_groups || [];

    // Para meio a meio: encontra o preço de cada metade e usa o maior
    if (halfFlavors) {
      let flavorPrices = [0, 0];
      let flavorScores = [0, 0];
      for (const g of groups) {
        if (g.status === "INACTIVE") continue;
        if (isSizeGroupName(g.name || "")) {
          // Tamanho: processa normalmente abaixo
          if (chosenSize) {
            for (const o of g.options || []) {
              if (o.status === "INACTIVE") continue;
              const pr = parseFloat(o.price || 0);
              const on = norm(o.name);
              let sc = 0;
              if (on === chosenSize) sc = 500;
              else if (on.includes(chosenSize) || chosenSize.includes(on)) sc = 400;
              else if (/\d/.test(chosenSize) && on.includes(chosenSize.replace(/\D/g, ""))) sc = 350;
              if (sc > bestSize.score) bestSize = { price: Number.isFinite(pr) ? pr : 0, score: sc };
            }
          }
        } else {
          for (const o of g.options || []) {
            if (o.status === "INACTIVE") continue;
            const pr = Number.isFinite(parseFloat(o.price)) ? parseFloat(o.price) : 0;
            for (let fi = 0; fi < 2; fi++) {
              const sc = scoreLineVsOption(halfFlavors[fi], o.name);
              if (sc > flavorScores[fi]) {
                flavorScores[fi] = sc;
                flavorPrices[fi] = pr;
              }
            }
          }
        }
      }
      // Cobra o sabor mais caro (regra padrão meio a meio)
      const halfFlavorPrice = Math.max(flavorPrices[0], flavorPrices[1]);
      const halfScore = Math.max(flavorScores[0], flavorScores[1]);
      if (halfScore > bestFlavor.score) bestFlavor = { price: halfFlavorPrice, score: halfScore };

      const combined = base + (chosenSize ? bestSize.price : 0) + bestFlavor.price;
      const rank = halfScore + (chosenSize ? bestSize.score : 0) * 0.1 + (combined > 0 ? 10 : 0);
      if (combined > 0 && rank > globalBest.score) {
        globalBest = {
          total: combined,
          score: rank,
          productId: p.id,
          breakdown: { base, size: chosenSize ? bestSize.price : 0, flavor: bestFlavor.price, addons: 0 },
        };
      }
      continue; // pula o loop genérico abaixo para este produto
    }

    for (const g of groups) {
      if (g.status === "INACTIVE") continue;
      const sizeG = isSizeGroupName(g.name || "");
      for (const o of g.options || []) {
        if (o.status === "INACTIVE") continue;
        const pr = parseFloat(o.price || 0);
        const on = norm(o.name);
        if (sizeG && chosenSize) {
          let sc = 0;
          if (on === chosenSize) sc = 500;
          else if (on.includes(chosenSize) || chosenSize.includes(on)) sc = 400;
          else if (/\d/.test(chosenSize) && on.includes(chosenSize.replace(/\D/g, ""))) sc = 350;
          if (sc > bestSize.score) bestSize = { price: Number.isFinite(pr) ? pr : 0, score: sc };
        } else if (!sizeG) {
          const sc = Math.max(scoreLineVsOption(lineName, o.name), scoreLineVsOption(flavorHint, o.name));
          if (sc > bestFlavor.score) bestFlavor = { price: Number.isFinite(pr) ? pr : 0, score: sc };
        }
      }
    }

    let addonSum = 0;
    const addons = Array.isArray(line.addons) ? line.addons : [];
    for (const ad of addons) {
      const adName = String(ad.name || "");
      let adBest = 0;
      for (const g of groups) {
        if (g.status === "INACTIVE") continue;
        for (const o of g.options || []) {
          if (o.status === "INACTIVE") continue;
          const sc = scoreLineVsOption(adName, o.name);
          const pr = parseFloat(o.price || 0);
          if (sc > 80 && pr > adBest) adBest = pr;
        }
      }
      addonSum += adBest * (ad.quantity || 1);
    }

    const flavorScore = bestFlavor.score;
    const sizeScore = chosenSize ? bestSize.score : 0;
    const prodBoost = scoreLineVsOption(lineName, p.name);
    const combined = base + (chosenSize ? bestSize.price : 0) + bestFlavor.price + addonSum;
    const rank = flavorScore + sizeScore + prodBoost * 0.05 + (combined > 0 ? 10 : 0);

    if (combined > 0 && rank > globalBest.score) {
      globalBest = {
        total: combined,
        score: rank,
        productId: p.id,
        breakdown: {
          base,
          size: chosenSize ? bestSize.price : 0,
          flavor: bestFlavor.price,
          addons: addonSum,
        },
      };
    }
  }

  if (globalBest.total <= 0) {
    for (const p of products) {
      const base = productBasePrice(p);
      if (base > 0 && scoreLineVsOption(lineName, p.name) >= 100) {
        return {
          unit: round2(base),
          matched: true,
          productId: p.id,
          breakdown: { base, size: 0, flavor: 0, addons: 0 },
        };
      }
    }
  }

  if (globalBest.total > 0) {
    return {
      unit: round2(globalBest.total),
      matched: true,
      productId: globalBest.productId,
      breakdown: globalBest.breakdown,
    };
  }

  return { unit: 0, matched: false, productId: null, breakdown: null };
}

function round2(n) {
  return Math.round((n || 0) * 100) / 100;
}

/**
 * @returns {{ items: Array, hasUnpriced: boolean, lines: Array<{ name: string, ok: boolean }> }}
 */
function enrichCartFromCatalog(cart, catalog, ctx = {}) {
  if (!Array.isArray(cart) || cart.length === 0) {
    return { items: [], hasUnpriced: false, lines: [] };
  }

  const lineMeta = [];
  const items = cart.map((line) => {
    const qty = Math.max(1, parseInt(line.quantity, 10) || 1);
    const priced = priceLineFromCatalog(line, catalog, ctx);
    const addons = Array.isArray(line.addons) ? line.addons : [];
    const enrichedAddons = addons.map((a) => {
      const ap = parseFloat(a.unit_price || 0);
      if (ap > 0) return { ...a, unit_price: round2(ap) };
      return { ...a, unit_price: 0 };
    });

    const unit = priced.unit > 0 ? priced.unit : round2(parseFloat(line.unit_price) || 0);
    const ok = unit > 0;
    lineMeta.push({ name: line.name, ok });

    return {
      ...line,
      id: line.id || priced.productId,
      quantity: qty,
      unit_price: unit,
      addons: enrichedAddons,
      _pricedFromCatalog: priced.matched,
    };
  });

  const hasUnpriced = items.some((i) => !i.unit_price || i.unit_price <= 0);
  return { items, hasUnpriced, lines: lineMeta };
}

module.exports = {
  enrichCartFromCatalog,
  priceLineFromCatalog,
  listProducts,
  norm,
};
