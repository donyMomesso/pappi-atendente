// src/services/context.service.js
// Define o modo da conversa: BASE, VIP (voltou em 24h), EVENT (sexta/sábado)

function getMode({ customer, now = new Date() }) {
  if (!customer) return "BASE";

  const last = customer.lastInteraction ? new Date(customer.lastInteraction) : null;
  const hoursSinceLast = last ? (now - last) / (1000 * 60 * 60) : 999;

  if (hoursSinceLast <= 24 && (customer.visitCount || 0) > 0) return "VIP";

  const day = now.getDay();
  if (day === 5 || day === 6) return "EVENT";

  return "BASE";
}

module.exports = { getMode };
