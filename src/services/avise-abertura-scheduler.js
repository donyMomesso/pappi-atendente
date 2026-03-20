// src/services/avise-abertura-scheduler.js
// Dispara notificarClientesAbertura às 18:00 (Campinas BRT) todos os dias.
// Evita reexecução no mesmo dia.

const aviseAbertura = require("./avise-abertura.service");

let lastRunDate = null; // "YYYY-MM-DD"
let schedulerRunning = false;

async function checkAndRun() {
  const now = new Date();
  const br = new Date(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const hour = br.getHours();
  const dateStr = `${br.getFullYear()}-${String(br.getMonth() + 1).padStart(2, "0")}-${String(br.getDate()).padStart(2, "0")}`;

  // Executar às 18:00-18:01, uma vez por dia
  if (hour === 18 && lastRunDate !== dateStr) {
    lastRunDate = dateStr;
    try {
      const results = await aviseAbertura.notificarClientesAbertura();
      const total = results.reduce((s, r) => s + r.sent, 0);
      if (total > 0) {
        console.log(`[AviseAbertura] Disparo 18h: ${total} cliente(s) notificado(s)`);
      }
    } catch (err) {
      console.error("[AviseAbertura] Erro no disparo 18h:", err.message);
      lastRunDate = null; // permite retry
    }
  }
}

function startScheduler() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  console.log("[AviseAbertura] Agendador iniciado (verifica às 18h)");
  setInterval(checkAndRun, 60 * 1000); // a cada minuto
  setTimeout(checkAndRun, 5000); // primeira verificação após 5s
}

module.exports = { startScheduler };
