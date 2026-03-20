// src/services/time-routing.service.js
// Roteamento de mensagens por horário para pizzaria.
// Usa hora local (America/Sao_Paulo).

const SLOTS = {
  MORNING: "08:00-12:00", // Produção artesanal, agendar para noite
  AFTERNOON: "12:01-17:00", // Antecipação, benefício para agendar
  PRE_OPEN: "17:01-17:59", // Urgência, forno aquecendo, topo da fila
  OPEN: "18:00-23:30", // Fluxo normal de vendas
  POST_CLOSE: "23:31-07:59", // Pós-fechamento, deixar contato
};

const MESSAGES = {
  MORNING: `Bom dia! ☀️ Aqui na Pizzaria a produção é 100% artesanal — amassamos a massa, preparamos os molhos e assamos na hora.

Quer garantir sua pizza para a noite? Agende agora e deixe tudo pronto pra quando a fome bater! 🍕

Voltamos às 18h. Até logo!`,
  AFTERNOON: `Boa tarde! 🌤️ Já pensou no jantar?

*Quem agenda agora ganha vantagem:* pode escolher um brinde ou entrar no topo da fila quando abrirmos às 18h!

Quer garantir seu pedido? É só avisar. 😊`,
  PRE_OPEN: `O forno já está aquecendo! 🔥

Em poucos minutos abrimos. Quem responder *agora* entra no topo da fila e garante pizza quentinha na hora.

Já sabe o que vai pedir? Me conta! 🍕`,
  POST_CLOSE: `Upa! Por aqui os fornos já se apagaram e nossa equipe foi descansar para amanhã fazer a melhor pizza de Campinas novamente. 😴

Mas não vá embora com fome! Você pode:

📱 *Ver o Cardápio:* Já escolhe o que vai pedir amanhã.
✍️ *Deixar seu contato:* Te mando um mimo se você for o primeiro a pedir quando abrirmos!

Voltamos às 18h. Até logo! 🍕`,
};

/**
 * Converte hora para minutos do dia (0-1439) para comparação fácil.
 * @param {number} h - hora (0-23)
 * @param {number} m - minuto (0-59)
 * @returns {number}
 */
function toMinutes(h, m) {
  return h * 60 + (m || 0);
}

/**
 * Retorna a hora local de Campinas (America/Sao_Paulo).
 * @returns {{ h: number, m: number, minutes: number }}
 */
function getLocalTime() {
  const now = new Date();
  const br = new Date(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const h = br.getHours();
  const m = br.getMinutes();
  return { h, m, minutes: toMinutes(h, m) };
}

/**
 * Determina o slot do fluxo com base na hora atual.
 * @param {number} [minutes] - minutos do dia (0-1439). Se omitido, usa hora atual.
 * @returns {{ flowId: string, message: string, isOpen: boolean }}
 */
function getTimeSlot(minutesParam) {
  const now = getLocalTime();
  const mins = minutesParam != null ? minutesParam : now.minutes;

  // POST_CLOSE: 23:31 (23*60+31=1411) até 07:59 (7*60+59=479)
  if (mins >= 1411 || mins < 480) {
    return { flowId: "POST_CLOSE", message: MESSAGES.POST_CLOSE, isOpen: false, hasAviseButton: false };
  }
  // MORNING: 08:00 (480) até 12:00 (720)
  if (mins >= 480 && mins <= 720) {
    return { flowId: "MORNING", message: MESSAGES.MORNING, isOpen: false, hasAviseButton: false };
  }
  // AFTERNOON: 12:01 (721) até 17:00 (1020)
  if (mins >= 721 && mins <= 1020) {
    return { flowId: "AFTERNOON", message: MESSAGES.AFTERNOON, isOpen: false, hasAviseButton: true };
  }
  // PRE_OPEN: 17:01 (1021) até 17:59 (1079)
  if (mins >= 1021 && mins <= 1079) {
    return { flowId: "PRE_OPEN", message: MESSAGES.PRE_OPEN, isOpen: false, hasAviseButton: true };
  }
  // OPEN: 18:00 (1080) até 23:30 (1410)
  return { flowId: "OPEN", message: null, isOpen: true, hasAviseButton: false };
}

/**
 * Função principal para o bot: recebe a hora atual e retorna o bloco do fluxo.
 * @param {Date} [date] - data/hora. Se omitido, usa agora.
 * @returns {{ flowId: string, message: string, isOpen: boolean }}
 */
function routeByTime(date) {
  let minutes;
  if (date) {
    const d = new Date(date);
    const br = new Date(d.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    minutes = toMinutes(br.getHours(), br.getMinutes());
  }
  return getTimeSlot(minutes);
}

module.exports = {
  SLOTS,
  MESSAGES,
  getLocalTime,
  getTimeSlot,
  routeByTime,
};
