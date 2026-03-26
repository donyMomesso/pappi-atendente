function makeRng(seed) {
  // Mulberry32: determinístico e rápido o suficiente para fuzzing.
  let t = seed >>> 0;
  return function rng() {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function chance(rng, p) {
  return rng() < p;
}

function normalizeSep(rng, s) {
  // Varia separadores para simular fragmentação/ruído.
  const seps = [",", " ", " - ", " , ", "/"];
  return s.replace(/\s+/g, " ").split(" ").map((w, idx, list) => (idx === 0 ? w : `${pick(rng, seps)}${w}`)).join("");
}

function generateAddressText(rng) {
  const streetBase = chance(rng, 0.5) ? "rua" : pick(rng, ["RUA", "rua", "Av.", "avenida"]);
  const streetName = chance(rng, 0.5) ? "colonia de minas" : pick(rng, ["colonia de minas", "colônia de minas", "colonia minas"]);
  const hasBairro = chance(rng, 0.6);
  const bairro = chance(rng, 0.7) ? "Jardim Santa Amalia" : "Jardim Santa Amália";
  const hasNumber = chance(rng, 0.75);
  const num = 100 + Math.floor(rng() * 900); // 100..999
  const parts = [streetBase, streetName];
  if (hasNumber) parts.push(String(num));
  if (hasBairro) parts.push("bairro", bairro);

  // Algumas variações de formato comuns.
  const raw = parts.join(chance(rng, 0.5) ? " " : " , ");
  // Mantém o texto “fácil” para o parse solto do bot.
  return raw.replace(/bairro\s+bairro/gi, "bairro").trim();
}

function generateSizeText(rng, sizeOptions, { withFlavor = true } = {}) {
  const numericHint = sizeOptions
    .map((s) => {
      const m = String(s).match(/\b(\d{1,2})\b/);
      return m ? Number(m[1]) : null;
    })
    .filter((n) => Number.isFinite(n));

  const pickNum = numericHint.length ? pick(rng, numericHint) : 16;

  const aliases = [
    { label: "brotinho", prob: 0.25 },
    { label: "media", prob: 0.25 },
    { label: "grande", prob: 0.25 },
  ];

  if (chance(rng, 0.7)) {
    const variant = pick(rng, ["16", "de 16", "pizza de 16", "tamanho 16"]);
    if (!withFlavor) return variant;
    return chance(rng, 0.5) ? variant : `${variant} meia calabresa meia frango com catupiry`;
  }

  const alias = pick(rng, aliases).label;
  if (!withFlavor) return alias;
  if (chance(rng, 0.5)) return `${alias}`;
  return `${alias} meia calabresa meia frango com catupiry`;
}

function generateStatusText(rng) {
  const variants = [
    "vc fez meu pedido",
    "meu pedido esta em andamento",
    "status do meu pedido",
    "onde esta meu pedido",
    "andamento do pedido",
  ];
  return pick(rng, variants);
}

function generateComplaintOrMenuText(rng) {
  const variants = [
    "demorou muito",
    "reclamacao",
    "reclamei porque veio errado",
    "quero falar com atendente",
    "menu",
    "cardapio",
    "refrigerante coca",
  ];
  return pick(rng, variants);
}

function generateScenario({ i, rng, sizeOptions }) {
  const types = ["address", "address_missing_number", "size_natural", "size_plus_flavor", "status_in_progress", "complaint_or_menu"];
  const t = pick(rng, types);

  const customerMessages = [];
  const expected = { type: t };

  if (t === "address" || t === "address_missing_number") {
    // Garante a condição: "address" sempre com número; "missing_number" sempre sem número.
    let txt = generateAddressText(rng);
    const hasDigits = /\b\d{1,4}\b/.test(txt);
    if (t === "address" && !hasDigits) {
      // tenta regenerar até conter dígitos
      for (let k = 0; k < 5 && !/\b\d{1,4}\b/.test(txt); k++) txt = generateAddressText(rng);
    }
    if (t === "address_missing_number") {
      const num = (txt.match(/\b\d{1,4}\b/) || [])[0] || "350";
      const withoutDigits = txt.replace(/\b\d{1,4}\b/g, "").replace(/\s{2,}/g, " ").trim();
      customerMessages.push(withoutDigits);
      customerMessages.push(num);
      customerMessages.push(pick(rng, ["sim", "ok", "confirma", "correto"]));
      expected.numberToProvide = num;
    } else {
      customerMessages.push(txt);
      customerMessages.push(pick(rng, ["sim", "ok", "confirma", "correto"]));
    }
  } else if (t === "size_natural" || t === "size_plus_flavor") {
    const withFlavor = t === "size_plus_flavor";
    const sizeTxt = generateSizeText(rng, sizeOptions, { withFlavor });
    customerMessages.push(sizeTxt);
    expected.sizePlusFlavor = withFlavor || /catu|catupi|meia|frango|calab/.test(String(sizeTxt).toLowerCase());

    if (t === "size_natural") {
      // Depois do bot pedir sabor, fornecemos um sabor válido.
      const flavor = pick(rng, [
        "meia calabresa meia frango com catupiry",
        "meio calabresa meio frango com catupiry",
        "meia calabresa meio frango com catupiry",
        "meia calabresa meia frango sem borda",
      ]);
      customerMessages.push(flavor);
      expected.flavorToProvide = flavor;
    }
  } else if (t === "status_in_progress") {
    customerMessages.push(generateStatusText(rng));
  } else {
    customerMessages.push(generateComplaintOrMenuText(rng));
  }

  return {
    id: `sc_${i}`,
    type: t,
    messages: customerMessages,
    expected,
  };
}

module.exports = {
  makeRng,
  generateScenario,
};

