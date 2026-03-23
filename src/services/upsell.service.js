// src/services/upsell.service.js
// Sugestões de upsell baseadas no contexto da conversa

function getUpsellHint({ historyText = "", userText = "", catalog: _catalog }) {
  const t = `${historyText || ""}\n${userText || ""}`.toLowerCase();

  if (t.includes("16") || t.includes("gigante") || t.includes("grande")) {
    return "Quer aproveitar e adicionar uma Coca 2L geladinha por um valor especial? 🥤";
  }
  if (t.includes("calabresa") || t.includes("calab")) {
    return "Essa combina demais com borda recheada 😋 Quer adicionar?";
  }
  if ((t.includes("frango") || t.includes("chicken")) && (t.includes("catupiry") || t.includes("crem"))) {
    return "Quer adicionar uma porçãozinha pra acompanhar? Fica top 😋";
  }
  return null;
}

module.exports = { getUpsellHint };
