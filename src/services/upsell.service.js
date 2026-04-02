// src/services/upsell.service.js
// Sugestões de upsell baseadas no contexto da conversa

function getUpsellHint({ historyText = "", userText = "", catalog: _catalog }) {
  const t = `${historyText || ""}
${userText || ""}`.toLowerCase();

  if (t.includes("borda") || t.includes("recheada") || t.includes("ja esta bom")) return null;
  if (t.includes("coca") || t.includes("guarana") || t.includes("refri") || t.includes("2l")) return null;
  if (t.includes("pizza") && !t.includes("combo")) {
    if (t.includes("gigante") || t.includes("16") || t.includes("2 pizza") || t.includes("2 pizzas")) {
      return "Use ancoragem: ofereça bebida 2L ou sobremesa como complemento do pedido grande em uma frase curta e natural.";
    }
    if (t.includes("calabresa") || t.includes("mussarela") || t.includes("portuguesa") || t.includes("frango")) {
      return "Use venda consultiva: sugira borda recheada ou refrigerante em frase única, assumindo benefício concreto como jantar completo ou economia no combo.";
    }
  }
  return "Se o pedido já estiver claro, faça uma única oferta de upsell de maior margem: bebida 2L, borda recheada ou sobremesa, com linguagem de facilidade e complemento do momento.";
}

module.exports = { getUpsellHint };
