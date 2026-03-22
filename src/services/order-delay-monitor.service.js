// src/services/order-delay-monitor.service.js
// Job que monitora pedidos em em_producao e dispara fluxo de atraso.

const prisma = require("../lib/db");
const log = require("../lib/logger").child({ service: "order-delay-monitor" });
const { getClients, listActive } = require("./tenant.service");
const { computeDailyAverages, computeEstimatedRemaining, formatTimeRange, getRiskLevel } = require("./order-delay.service");
const { getWeatherForCity } = require("./weather.service");
const { generateCompensationCoupon, markCouponSent } = require("./coupon.service");
const chatMemory = require("./chat-memory.service");
const baileys = require("./baileys.service");
const socketService = require("./socket.service");

const DELAY_THRESHOLD_MIN = 60;
const ALERT_INTERVAL_MIN = 15; // 15 ou 20 min entre alertas
const PRIORITY_MAX_MIN = 90;

const CW_PROD_STATUSES = ["em_producao", "in_production"];

async function getDelayAlertInterval(tenantId) {
  const cfg = await prisma.config.findUnique({ where: { key: `${tenantId}:delay_alert_interval_min` } });
  return cfg ? parseInt(cfg.value, 10) || ALERT_INTERVAL_MIN : ALERT_INTERVAL_MIN;
}

async function processTenant(tenantId) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant?.active) return;

  const intervalMin = await getDelayAlertInterval(tenantId);
  const threshold = DELAY_THRESHOLD_MIN * 60 * 1000;

  // Pedidos em em_producao com cwOrderId
  const orders = await prisma.order.findMany({
    where: {
      tenantId,
      cwOrderId: { not: null },
      status: { notIn: ["cancelled", "delivered", "lead"] },
      OR: [
        { cardapiowebStatus: { in: CW_PROD_STATUSES } },
        { cardapiowebStatus: null, status: { in: CW_PROD_STATUSES } },
      ],
    },
    include: { customer: true },
  });

  const now = Date.now();
  const { avgProdToOutMinutes, avgOutToDoneMinutes } = await computeDailyAverages(tenantId);
  const weather = await getWeatherForCity(tenant.city || "São Paulo");
  const weatherFactor = weather?.delayFactor ?? 1;

  for (const order of orders) {
    const statusChangedAt = order.statusChangedAt || order.createdAt;
    const timeInProdMs = now - new Date(statusChangedAt).getTime();
    const timeInProdMin = Math.floor(timeInProdMs / 60_000);

    if (timeInProdMin < DELAY_THRESHOLD_MIN) continue;

    const { min: estMin, max: estMax } = computeEstimatedRemaining({
      timeInProdMinutes: timeInProdMin,
      avgProdToOutMinutes,
      avgOutToDoneMinutes,
      weatherDelayFactor: weatherFactor,
    });

    const riskLevel = getRiskLevel(timeInProdMin, false, false);
    const faixa = formatTimeRange(estMin, estMax);
    const customerName = order.customer?.name || "Cliente";
    const phone = order.customer?.phone;
    const orderRef = order.id.slice(-6).toUpperCase();

    // Atualiza campos do pedido
    await prisma.order.update({
      where: { id: order.id },
      data: {
        timeInCurrentStatusMinutes: timeInProdMin,
        dailyAvgProdToOutMinutes: avgProdToOutMinutes,
        dailyAvgOutToDoneMinutes: avgOutToDoneMinutes,
        estimatedRemainingMin: estMin,
        estimatedRemainingMax: estMax,
        weatherDelayFactor: weatherFactor,
        deliveryRiskLevel: riskLevel,
      },
    });

    const delayAlertSentAt = order.delayAlertSentAt ? new Date(order.delayAlertSentAt).getTime() : 0;
    const secondDelayAlertSentAt = order.secondDelayAlertSentAt ? new Date(order.secondDelayAlertSentAt).getTime() : 0;
    const thirdDelayAlertSentAt = order.thirdDelayAlertSentAt ? new Date(order.thirdDelayAlertSentAt).getTime() : 0;

    // 1º alerta: 60 min
    if (!order.delayAlertSentAt) {
      await sendFirstAlert(tenantId, order, customerName, faixa, weather, phone);
      await prisma.order.update({
        where: { id: order.id },
        data: { delayAlertSentAt: new Date(), attendantAlertSentAt: new Date() },
      });
      await createAttendantAlert(tenantId, order, timeInProdMin, faixa, riskLevel, weather);
      socketService.emitDelayAlert(tenantId, {
        orderId: order.id,
        orderRef: order.id.slice(-6).toUpperCase(),
        customerName: order.customer?.name || "—",
        phone: order.customer?.phone || "—",
        timeInProdMinutes: timeInProdMin,
        estimatedRange: faixa,
        riskLevel,
        lastMessage: "1º alerta enviado",
        rain: weather?.rain ?? false,
      });
      log.info({ orderId: order.id, tenantId }, "1º alerta de atraso enviado");
      continue;
    }

    // 2º alerta: +15 ou 20 min
    if (!order.secondDelayAlertSentAt && now - delayAlertSentAt >= intervalMin * 60 * 1000) {
      await sendSecondAlert(tenantId, order, customerName, phone);
      await prisma.order.update({ where: { id: order.id }, data: { secondDelayAlertSentAt: new Date() } });
      log.info({ orderId: order.id }, "2º alerta de atraso enviado");
      continue;
    }

    // 3º alerta: +15 ou 20 min
    if (!order.thirdDelayAlertSentAt && secondDelayAlertSentAt && now - secondDelayAlertSentAt >= intervalMin * 60 * 1000) {
      await sendThirdAlert(tenantId, order, customerName, phone);
      await prisma.order.update({ where: { id: order.id }, data: { thirdDelayAlertSentAt: new Date() } });
      log.info({ orderId: order.id }, "3º alerta de atraso enviado");
      continue;
    }

    // 90+ min: prioridade máxima, escalar para humano
    if (timeInProdMin >= PRIORITY_MAX_MIN && riskLevel !== "escalado_para_humano") {
      await prisma.order.update({
        where: { id: order.id },
        data: { deliveryRiskLevel: "prioridade_maxima", watchedByAttendant: "system" },
      });
      await notifyAttendantPriority(tenantId, order, timeInProdMin, orderRef, customerName, phone);
      socketService.emitDelayAlert(tenantId, {
        orderId: order.id,
        orderRef,
        customerName,
        phone: phone || "—",
        timeInProdMinutes: timeInProdMin,
        riskLevel: "prioridade_maxima",
        lastMessage: "Escalado para humano",
        rain: weather?.rain ?? false,
      });
    }
  }
}

async function sendFirstAlert(tenantId, order, customerName, faixa, weather, phone) {
  if (!phone) return;
  const { wa } = await getClients(tenantId);
  const msg = weather?.rain
    ? `Oi, ${customerName}. Seu pedido ainda está em produção e hoje, por conta da chuva e do ritmo mais lento da operação, a previsão foi atualizada para cerca de ${faixa}. Estou acompanhando seu pedido de perto para não te deixar sem retorno.`
    : `Oi, ${customerName}. Não quis te deixar sem atualização. Seu pedido ainda está em produção e hoje nossa operação está mais lenta que o normal. Pela média de andamento dos pedidos de hoje, a nova previsão é de cerca de ${faixa}. Fique tranquilo, estou de olho no seu pedido e sigo te atualizando por aqui.`;
  await wa.sendText(phone, msg).catch((e) => log.warn({ err: e.message }, "Falha ao enviar 1º alerta"));
  if (order.customerId) await chatMemory.push(order.customerId, "assistant", msg, "Sistema", null, "text");
}

async function sendSecondAlert(tenantId, order, customerName, phone) {
  if (!phone) return;
  const { wa } = await getClients(tenantId);
  const msg = `${customerName}, passando para te atualizar novamente: seu pedido ainda está em produção, e eu já deixei seu caso em atenção com o time para acompanhar mais de perto.`;
  await wa.sendText(phone, msg).catch((e) => log.warn({ err: e.message }, "Falha ao enviar 2º alerta"));
  if (order.customerId) await chatMemory.push(order.customerId, "assistant", msg, "Sistema", null, "text");
}

async function sendThirdAlert(tenantId, order, customerName, phone) {
  if (!phone) return;
  const { wa } = await getClients(tenantId);
  const msg = `${customerName}, sigo acompanhando seu pedido e já sinalizei a produção para dar saída o mais rápido possível. Assim que houver avanço, eu te aviso aqui.`;
  await wa.sendText(phone, msg).catch((e) => log.warn({ err: e.message }, "Falha ao enviar 3º alerta"));
  if (order.customerId) await chatMemory.push(order.customerId, "assistant", msg, "Sistema", null, "text");
}

async function createAttendantAlert(tenantId, order, timeInProdMin, faixa, riskLevel, weather) {
  const payload = {
    orderId: order.id,
    orderRef: order.id.slice(-6).toUpperCase(),
    customerName: order.customer?.name || "—",
    phone: order.customer?.phone || "—",
    timeInProdMinutes: timeInProdMin,
    estimatedRange: faixa,
    riskLevel,
    lastMessage: "1º alerta enviado ao cliente",
    rain: weather?.rain ?? false,
  };
  socketService.emitDelayAlert(tenantId, payload);
}

async function notifyAttendantPriority(tenantId, order, timeInProdMin, orderRef, customerName, phone) {
  await baileys
    .notify(
      `🚨 *Pedido #${orderRef} em prioridade máxima!* (${timeInProdMin} min em produção)\n` +
        `👤 ${customerName}\n📞 ${phone || "—"}\n\nAcesse o painel para acompanhar.`,
    )
    .catch(() => {});
}

async function run() {
  try {
    const tenants = await listActive();
    for (const t of tenants) {
      try {
        await processTenant(t.id);
      } catch (err) {
        log.error({ err: err.message, tenantId: t.id }, "Erro ao processar tenant no monitor de atraso");
      }
    }
  } catch (err) {
    log.error({ err: err.message }, "Erro no job order-delay-monitor");
  }
}

const INTERVAL_MS = 5 * 60 * 1000; // 5 min
let running = false;

function startScheduler() {
  if (running) return;
  running = true;
  log.info("Order-delay-monitor: scheduler iniciado (intervalo: 5 min)");
  setInterval(run, INTERVAL_MS);
  setTimeout(run, 90_000);
}

module.exports = { startScheduler, run, sendFirstAlert, sendSecondAlert, sendThirdAlert };
