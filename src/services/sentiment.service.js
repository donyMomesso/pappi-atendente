// src/services/sentiment.service.js
// Detecção de sentimento e intenção nas mensagens do cliente.
// Identifica: reclamações, insatisfação, elogios, urgência, dúvidas.
// Funciona sem IA (regex/heurística) para ser rápido e sem custo.

const COMPLAINT_PATTERNS = [
  // Qualidade do produto
  /n[aã]o\s*(d[aá]|deu)\s*(pra|para)\s*(com|consum)/i,
  /pizza\s*(fria|crua|queimad|ruim|horrivel|horrível|pessim)/i,
  /comida\s*(fria|ruim|estragad|pessim)/i,
  /veio\s*(errad|frio|fria|diferente|trocad|faltando)/i,
  /n[aã]o\s*(veio|chegou|recebi|trouxe)/i,
  /faltou|faltando|incompleto/i,
  /sabor\s*(errad|trocad|diferente)/i,
  /mass[ao]\s*(crua|dura|mole|grudent)/i,

  // Entrega
  /atras(o|ado|ada)|demor(a|ou|ando)\s*(muito|demais)?/i,
  /n[aã]o\s*chegou|cad[eê]\s*(o|meu)\s*(pedido|pizza|entrega)/i,
  /entrega\s*(errad|atrasad|demor)/i,
  /motoboy.*(n[aã]o|sumiu|errad)/i,
  /endere[cç]o\s*errad/i,

  // Cobrança/pagamento
  /cobr(ou|aram|ança)\s*(errad|a\s*mais|demais|indevid)/i,
  /taxa.*(absurd|car[ao]|alt[ao]|errad|indevid)/i,
  /pre[cç]o\s*(errad|diferente|alt|absurd)/i,
  /estorno|reembols|devol(ver|ução|ucao)\s*(dinheiro|valor|pix)/i,
  /paguei\s*(a\s*mais|errad|duas?\s*vez)/i,

  // Insatisfação geral
  /insatisf(eit|eito|eita|ação)/i,
  /decep(cion|çã|cao)/i,
  /p[eé]ssim[oa]/i,
  /horrivel|horrível/i,
  /nunca\s*mais/i,
  /pior\s*(pizza|pedido|atendimento|comida|experiência)/i,
  /n[aã]o\s*gostei/i,
  /n[aã]o\s*recomendo/i,
  /uma\s*vergonha/i,
  /falta\s*de\s*respeito/i,
  /absurdo/i,
  /rid[ií]culo/i,

  // Cancelamento/devolução
  /quer[oe]\s*(cancel|devol|trocar)/i,
  /cancel(a|ar|e)\s*(o|meu|esse)?\s*(pedido)?/i,
  /devol(ver|ve|ução|ucao)/i,

  // Frases naturais de queixa
  /n[aã]o\s*(d[aá]|deu|da)\s*pra\s*(comer|aceitar|engolir)/i,
  /jogou?\s*(fora|no\s*lixo)/i,
  /vou\s*(procurar|ir)\s*(o|no)\s*procon/i,
  /vou\s*denunciar/i,

  // Pedido errado
  /pedido\s*(errad|trocad|incompleto)/i,
  /pedi\s+\w+\s+e\s+veio/i,
  /trocaram\s*(meu|o)\s*pedido/i,

  // Taxa/valor errado
  /taxa\s*(pass|sub|acima|maior|aument)/i,
  /valor\s*(errad|diferente|acima|maior|absurd)/i,
  /cobrando\s*(a\s*mais|demais|errad)/i,
];

const PRAISE_PATTERNS = [
  /maravilh|delici|otim|excelente|perfeito|parab[eé]ns|sensacional/i,
  /melhor\s*(pizza|pizzaria|comida|entrega|atendimento)/i,
  /adorei|amei|muito\s*bo[am]/i,
  /top\s*(demais)?|show|incrível|incr[ií]vel/i,
  /sempre\s*peço|sempre\s*compro|cliente\s*fiel/i,
  /nota\s*10|nota\s*mil|estrelas/i,
  /(voc[eê]s\s*)?s[aã]o\s*(os|as)\s*(melhor|melh)/i,
];

const URGENCY_PATTERNS = [
  /urgent[ee]|emergência|emerge?ncia/i,
  /preciso\s*agora|r[aá]pido\s*(por\s*favor)?/i,
  /j[aá]\s*(faz|tem)\s*\d+\s*(hora|min|tempo)/i,
  /esperando\s*(h[aá]|faz)\s*(muito|horas|tempo)/i,
  /por\s*favor\s*me\s*(ajud|atend)/i,
];

const DOUBT_PATTERNS = [
  /n[aã]o\s*entend[io]|como\s*assim|n[aã]o\s*compreend/i,
  /por\s*qu[eê]|porque\s*(que|cobr|est[aá])/i,
  /explica|me\s*explica|pode\s*explicar/i,
  /como\s*(funciona|fa[cç]o|peço|pago|cancel)/i,
];

/**
 * Analisa o sentimento de uma mensagem.
 * @param {string} text
 * @returns {{ sentiment: string, score: number, tags: string[], isComplaint: boolean, isUrgent: boolean }}
 */
function analyze(text) {
  if (!text || typeof text !== "string") {
    return { sentiment: "neutral", score: 0, tags: [], isComplaint: false, isUrgent: false };
  }

  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const tags = [];
  let score = 0;

  // Reclamação (-3 por match)
  const complaintMatches = COMPLAINT_PATTERNS.filter((p) => p.test(text));
  if (complaintMatches.length > 0) {
    score -= complaintMatches.length * 3;
    tags.push("reclamacao");
  }

  // Elogio (+3 por match)
  const praiseMatches = PRAISE_PATTERNS.filter((p) => p.test(text));
  if (praiseMatches.length > 0) {
    score += praiseMatches.length * 3;
    tags.push("elogio");
  }

  // Urgência (-2)
  const urgencyMatches = URGENCY_PATTERNS.filter((p) => p.test(text));
  if (urgencyMatches.length > 0) {
    score -= 2;
    tags.push("urgente");
  }

  // Dúvida (-1)
  const doubtMatches = DOUBT_PATTERNS.filter((p) => p.test(text));
  if (doubtMatches.length > 0) {
    score -= 1;
    tags.push("duvida");
  }

  // Pontuação extra: muitas exclamações/caps = intensidade
  const exclamations = (text.match(/!/g) || []).length;
  const capsRatio = text.replace(/[^A-Z]/g, "").length / Math.max(text.length, 1);
  if (exclamations >= 3 || capsRatio > 0.5) {
    score += score < 0 ? -1 : score > 0 ? 1 : 0;
    tags.push("intenso");
  }

  // Palavrões = reclamação forte
  if (/merda|porra|caralho|vsf|pqp|fdp|bosta|lixo/i.test(t)) {
    score -= 4;
    if (!tags.includes("reclamacao")) tags.push("reclamacao");
  }

  const sentiment = score <= -3 ? "negative" : score >= 3 ? "positive" : "neutral";
  const isComplaint = score <= -3 || tags.includes("reclamacao");
  const isUrgent = tags.includes("urgente");

  return { sentiment, score, tags, isComplaint, isUrgent };
}

/**
 * Analisa um conjunto de mensagens recentes de um cliente para determinar o sentimento geral.
 * @param {Array<{role:string, text:string}>} messages
 * @returns {{ overall: string, score: number, complaints: string[], hasComplaint: boolean }}
 */
function analyzeConversation(messages) {
  if (!messages?.length) {
    return { overall: "neutral", score: 0, complaints: [], hasComplaint: false };
  }

  const customerMsgs = messages.filter((m) => m.role === "customer");
  let totalScore = 0;
  const complaints = [];

  for (const msg of customerMsgs.slice(-10)) {
    const result = analyze(msg.text);
    totalScore += result.score;
    if (result.isComplaint) {
      complaints.push(msg.text?.slice(0, 100));
    }
  }

  const overall = totalScore <= -5 ? "negative" : totalScore >= 5 ? "positive" : "neutral";

  return {
    overall,
    score: totalScore,
    complaints,
    hasComplaint: complaints.length > 0,
  };
}

module.exports = { analyze, analyzeConversation, COMPLAINT_PATTERNS, PRAISE_PATTERNS };
