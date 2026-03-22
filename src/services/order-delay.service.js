// src/services/order-delay.service.js
// Cálculo de médias do dia e previsão recalculada para pedidos em atraso.

const prisma = require("../lib/db");
const log = require("../lib/logger").child({ service: "order-delay" });

// Mapeamento de status CW para nosso modelo
const CW_PROD = ["em_producao", "in_production", "in_production"];
const CW_OUT = ["saiu_para_entrega", "pronto_para_retirada", "dispatched", "ready_for_pickup"];
const CW_DONE = ["pedido_concluido", "delivered", "concluded"];

function isProd(status) {
  return CW_PROD.includes(String(status || "").toLowerCase());
}
function isOut(status) {
  return CW_OUT.includes(String(status || "").toLowerCase());
}
function isDone(status) {
  return CW_DONE.includes(String(status || "").toLowerCase());
}

/**
 * Calcula médias do dia (prod->out e out->done) para o tenant.
 * Pseudocódigo:
 *   hoje = início do dia (00:00)
 *   logs = OrderStatusLog do tenant onde createdAt >= hoje
 *   Para cada pedido com cwOrderId:
 *     se tem log em_producao e depois saiu_para_entrega -> dt_prod_to_out
 *     se tem log saiu_para_entrega e depois pedido_concluido -> dt_out_to_done
 *   media_prod_to_out = média(dt_prod_to_out) ou 30 min default
 *   media_out_to_done = média(dt_out_to_done) ou 25 min default
 */
async function computeDailyAverages(tenantId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const ordersWithLogs = await prisma.order.findMany({
    where: {
      tenantId,
      cwOrderId: { not: null },
      createdAt: { gte: today },
      status: { notIn: ["cancelled", "lead"] },
    },
    include: {
      statusLogs: {
        where: { createdAt: { gte: today } },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  const prodToOut = [];
  const outToDone = [];

  for (const order of ordersWithLogs) {
    const logs = order.statusLogs || [];
    let tProd = null;
    let tOut = null;
    let tDone = null;

    for (const l of logs) {
      const s = String(l.status || "").toLowerCase();
      const at = new Date(l.createdAt).getTime();
      if (isProd(s)) tProd = at;
      if (isOut(s)) {
        tOut = at;
        if (tProd != null) {
          prodToOut.push((tOut - tProd) / 60_000);
          tProd = null;
        }
      }
      if (isDone(s)) {
        tDone = at;
        if (tOut != null) {
          outToDone.push((tDone - tOut) / 60_000);
        }
      }
    }
  }

  const avgProdToOut = prodToOut.length ? prodToOut.reduce((a, b) => a + b, 0) / prodToOut.length : 30;
  const avgOutToDone = outToDone.length ? outToDone.reduce((a, b) => a + b, 0) / outToDone.length : 25;

  return {
    avgProdToOutMinutes: Math.round(avgProdToOut * 10) / 10,
    avgOutToDoneMinutes: Math.round(avgOutToDone * 10) / 10,
    sampleCountProd: prodToOut.length,
    sampleCountOut: outToDone.length,
  };
}

/**
 * Calcula previsão recalculada para um pedido em em_producao.
 * restante_producao = media_prod_to_out - tempo_atual_em_producao
 * se restante_producao < 5 min -> 5
 * restante_total = restante_producao + media_out_to_done
 * Aplica weather_delay_factor e retorna faixa { min, max }.
 */
function computeEstimatedRemaining(opts) {
  const {
    timeInProdMinutes,
    avgProdToOutMinutes = 30,
    avgOutToDoneMinutes = 25,
    weatherDelayFactor = 1,
    marginMinutes = 5,
  } = opts;

  let restanteProd = avgProdToOutMinutes - timeInProdMinutes;
  if (restanteProd < 5) restanteProd = 5;
  if (restanteProd < 0) restanteProd = 5; // já passou da média

  let restanteTotal = restanteProd + avgOutToDoneMinutes;
  restanteTotal *= weatherDelayFactor;
  restanteTotal = Math.round(restanteTotal);

  const min = Math.max(5, Math.floor(restanteTotal * 0.85));
  const max = Math.ceil(restanteTotal * 1.15) + marginMinutes;

  return { min, max };
}

/**
 * Formata faixa em texto humanizado. Ex: "15 a 25 minutos"
 */
function formatTimeRange(min, max) {
  if (min >= 60 || max >= 60) {
    const minH = Math.floor(min / 60);
    const minM = min % 60;
    const maxH = Math.floor(max / 60);
    const maxM = max % 60;
    if (minH === maxH) return `${minH}h${minM ? ` ${minM}min` : ""} a ${maxH}h${maxM ? ` ${maxM}min` : ""}`;
    return `cerca de ${minH}h a ${maxH}h`;
  }
  return `${min} a ${max} minutos`;
}

/**
 * Determina nível de risco do atraso.
 */
function getRiskLevel(timeInProdMinutes, customerAskedStatus, customerUpset) {
  if (timeInProdMinutes >= 90) return "prioridade_maxima";
  if (customerUpset || customerAskedStatus) return "critico";
  if (timeInProdMinutes >= 75) return "critico";
  if (timeInProdMinutes >= 60) return "alto";
  return "medio";
}

module.exports = {
  computeDailyAverages,
  computeEstimatedRemaining,
  formatTimeRange,
  getRiskLevel,
  isProd,
  isOut,
  isDone,
  CW_PROD,
  CW_OUT,
  CW_DONE,
};
