// src/services/disc.service.js
// Detecção DISC (perfil de comportamento) + guia de tom para respostas mais humanizadas

function detectDISC(historyText, userText) {
  const t = `${historyText || ""}\n${userText || ""}`.toLowerCase();
  const score = { D: 0, I: 0, S: 0, C: 0 };

  if (/(rápido|agora|urgente|pra ontem|resolve|quero logo|sem enrolar|objetivo|direto)/i.test(t)) score.D += 3;
  if (/(quanto fica|valor|taxa|preço|total|fechou|manda)/i.test(t)) score.D += 2;

  if (/(kkk|haha|top|show|amei|perfeito|manda aí|bora|😍|😂|🔥|👏)/i.test(t)) score.I += 3;
  if (/(promo|novidade|qual recomenda|surpreende|capricha)/i.test(t)) score.I += 2;

  if (/(tranquilo|de boa|sem pressa|tanto faz|pode ser|confio|obrigado|valeu)/i.test(t)) score.S += 3;
  if (/(família|criança|pra todo mundo|clássica)/i.test(t)) score.S += 1;

  if (/(detalhe|certinho|confirma|comprovante|conforme|tamanho|ingrediente|sem|com|meio a meio|observação)/i.test(t))
    score.C += 3;
  if (/(cep|número|bairro|endereço|nota|troco|cartão|pix)/i.test(t)) score.C += 2;

  let best = "S";
  let bestVal = -1;
  for (const k of ["D", "I", "S", "C"]) {
    if (score[k] > bestVal) {
      bestVal = score[k];
      best = k;
    }
  }
  return best;
}

function discToneGuidance(disc) {
  switch (disc) {
    case "D":
      return "Tom: direto e rápido. Frases curtas. 1 pergunta por vez. Máx 1 emoji.";
    case "I":
      return "Tom: animado e caloroso. Pode usar 1–2 emojis. Sugira 1 recomendação.";
    case "C":
      return "Tom: claro e organizado. Confirme detalhes (tamanho, sabores, endereço). Sem textão.";
    case "S":
    default:
      return "Tom: acolhedor e tranquilo. Passe segurança. 1 pergunta por vez.";
  }
}

module.exports = { detectDISC, discToneGuidance };
