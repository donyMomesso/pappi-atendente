// src/services/cw-retry.service.js
// Fila de reprocessamento para pedidos que falharam no CardápioWeb.
// Roda a cada 5 min, tenta reenviar pedidos sem cwOrderId das últimas 24h.
// Após 3 falhas, marca como failed e notifica operador via Baileys.

const prisma = require("../lib/db");

const MAX_ATTEMPTS   = 3;
const RETRY_INTERVAL = 5 * 60 * 1000; // 5 min

let schedulerRunning = false;

async function processQueue() {
  try {
    // Busca pedidos criados há menos de 24h sem cwOrderId e não cancelados/entregues
    const failedOrders = await prisma.order.findMany({
      where: {
        cwOrderId: null,
        status:    { notIn: ["cancelled", "delivered", "cw_failed"] },
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      orderBy: { createdAt: "asc" },
      take:    20,
      include: { customer: true, tenant: true },
    });

    if (!failedOrders.length) return;

    console.log(`[CW-Retry] ${failedOrders.length} pedido(s) na fila de reprocessamento`);

    const { getClients } = require("./tenant.service");
    const baileys        = require("./baileys.service");

    for (const order of failedOrders) {
      // Conta tentativas anteriores nos logs de status
      const attempts = await prisma.orderStatusLog.count({
        where: { orderId: order.id, status: "cw_retry_failed" },
      });

      if (attempts >= MAX_ATTEMPTS) {
        // Esgotou tentativas — marca como falha definitiva e notifica
        await prisma.order.update({
          where: { id: order.id },
          data:  { status: "cw_failed" },
        });
        await prisma.orderStatusLog.create({
          data: { orderId: order.id, status: "cw_failed", source: "system",
            note: `Falha definitiva após ${MAX_ATTEMPTS} tentativas de reenvio ao CW` },
        });

        const orderRef = order.id.slice(-6).toUpperCase();
        const name     = order.customer?.name || order.customer?.phone || "Cliente";
        await baileys.notify(
          `🚨 *Pedido #${orderRef} não enviado ao CW após ${MAX_ATTEMPTS} tentativas!*\n` +
          `👤 ${name}\n💰 R$ ${order.total.toFixed(2)}\n\n` +
          `Acesse o painel para processar manualmente.`
        ).catch(() => {});

        console.error(`[CW-Retry] Pedido #${orderRef} falhou definitivamente após ${MAX_ATTEMPTS} tentativas`);
        continue;
      }

      // Tenta reenviar ao CW
      try {
        const { cw } = await getClients(order.tenantId);

        if (!order.cwPayload) {
          console.warn(`[CW-Retry] Pedido ${order.id} sem cwPayload — não pode ser reenviado`);
          continue;
        }

        const cwPayload  = JSON.parse(order.cwPayload);
        const cwResponse = await cw.createOrder(cwPayload);
        const cwOrderId  = cwResponse?.id || cwResponse?.order_id;

        // Sucesso — atualiza o pedido com o ID do CW
        await prisma.order.update({
          where: { id: order.id },
          data:  { cwOrderId, cwResponse: JSON.stringify(cwResponse) },
        });
        await prisma.orderStatusLog.create({
          data: { orderId: order.id, status: "cw_retry_success", source: "system",
            note: `Pedido enviado ao CW com sucesso na tentativa ${attempts + 1}` },
        });

        const orderRef = order.id.slice(-6).toUpperCase();
        console.log(`[CW-Retry] ✅ Pedido #${orderRef} reenviado com sucesso (cwOrderId: ${cwOrderId})`);

        // Notifica operador que o pedido foi recuperado
        await baileys.notify(
          `✅ *Pedido #${orderRef} recuperado!*\n` +
          `Foi enviado ao CardápioWeb com sucesso na tentativa ${attempts + 1}.`
        ).catch(() => {});

      } catch (err) {
        // Registra a tentativa falha
        await prisma.orderStatusLog.create({
          data: { orderId: order.id, status: "cw_retry_failed", source: "system",
            note: `Tentativa ${attempts + 1}/${MAX_ATTEMPTS} falhou: ${err.message}` },
        });
        console.warn(`[CW-Retry] Tentativa ${attempts + 1} falhou para pedido ${order.id}: ${err.message}`);
      }

      // Pausa entre reprocessamentos para não sobrecarregar o CW
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (err) {
    console.error("[CW-Retry] Erro geral:", err.message);
  }
}

function startScheduler() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  console.log("[CW-Retry] Agendador iniciado (intervalo: 5 min)");
  setInterval(processQueue, RETRY_INTERVAL);
  // Primeira execução após 1 min (espera o boot)
  setTimeout(processQueue, 60_000);
}

// Reprocessamento manual (via rota admin)
async function runNow() {
  return processQueue();
}

module.exports = { startScheduler, runNow };
