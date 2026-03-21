// src/services/deescalation.service.js
// Detecção de irritação e pedido de atendente humano — evita escalar conflito

function detectHumanRequest(text) {
  const t = String(text || "").toLowerCase();
  return /(humano|atendente|pessoa|moça|moca|falar com|me atende|quero atendimento|chama alguém|gerente)/i.test(t);
}

function detectIrritation(text) {
  const t = String(text || "").toLowerCase();
  return /(caracas|aff|pqp|irritad|raiva|rid[ií]culo|absurdo|lixo|merda|porra|n[aã]o aguento|ta errado|de novo|para|chega|vsf)/i.test(t);
}

function needsDeescalation(text) {
  return detectHumanRequest(text) || detectIrritation(text);
}

module.exports = {
  detectHumanRequest,
  detectIrritation,
  needsDeescalation,
};
