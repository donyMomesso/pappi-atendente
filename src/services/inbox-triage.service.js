// src/services/inbox-triage.service.js
// Triagem leve (heurística) para classificar o tipo da conversa antes do fluxo comercial.
// FASE 1: sem IA pesada, sem refatoração do pedido — só decide o "mode" e evita prompts errados.

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

function triage({ text, session }) {
  const t = norm(text);
  const step = session?.step || "MENU";

  const isVeryShort = t.length > 0 && t.length <= 3;
  const looksFragmented =
    isVeryShort ||
    /^(ok|blz|sim|nao|não|opa|oi|ola|olá|quero|manda|isso|ai|aí|e|mais|meia|metade)$/i.test(t);

  // Intenções (ordem de prioridade)
  const isHuman = includesAny(t, ["atendente", "humano", "pessoa", "falar com", "suporte", "ajuda humana"]);
  const isComplaint = includesAny(t, ["reclam", "ruim", "horrivel", "péssim", "atras", "demor", "frio", "errad", "faltou", "veio errado", "cancel"]);
  const isStatus = includesAny(t, [
    "onde esta",
    "onde ta",
    "onde está",
    "meu pedido",
    "status",
    "situacao",
    "situação",
    "chegou",
    "previsao",
    "previsão",
    "quanto tempo",
    "rastreio",
    "andamento",
  ]);
  const isMenu = includesAny(t, ["cardapio", "cardápio", "menu", "sabores", "tamanhos", "precos", "preços", "valores"]);
  const isDriver = includesAny(t, ["motoboy", "entregador", "to chegando", "tô chegando", "cheguei", "portaria", "interfone"]);

  const hasOrderSignal = includesAny(t, [
    "pizza",
    "lasanha",
    "calabresa",
    "mussarela",
    "frango",
    "portuguesa",
    "meia",
    "broto",
    "media",
    "média",
    "grande",
    "gigante",
    "retirada",
    "entrega",
    "cep",
    "rua",
    "bairro",
    "numero",
    "nº",
    "pix",
    "cartao",
    "dinheiro",
  ]);

  let intent = "OTHER";
  let confidence = 0.5;

  if (isHuman) {
    intent = "HUMAN";
    confidence = 0.95;
  } else if (isComplaint) {
    intent = "COMPLAINT";
    confidence = 0.85;
  } else if (isStatus) {
    intent = "ORDER_STATUS";
    confidence = 0.9;
  } else if (isDriver) {
    intent = "DRIVER";
    confidence = 0.8;
  } else if (isMenu) {
    intent = "MENU";
    confidence = 0.85;
  } else if (hasOrderSignal) {
    intent = "NEW_ORDER";
    confidence = 0.7;
  }

  // Se já está em fluxo de pedido, mantenha em ORDER (não tenta reclassificar demais)
  const inOrderFlow = step && !["MENU", "ASK_NAME", "CHOOSE_PRODUCT_TYPE", "FULFILLMENT"].includes(step);
  if (inOrderFlow && intent === "OTHER") {
    intent = "NEW_ORDER";
    confidence = 0.6;
  }

  return {
    intent,
    confidence,
    fragmented: looksFragmented,
    shouldWaitMore: looksFragmented && ["MENU", "CHOOSE_PRODUCT_TYPE", "FULFILLMENT"].includes(step),
  };
}

module.exports = { triage };

