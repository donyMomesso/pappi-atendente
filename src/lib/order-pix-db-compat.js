// src/lib/order-pix-db-compat.js
// Produção pode estar sem as colunas PIX em public.orders (migrate não aplicada).
// Prisma inclui pixTxid/pixE2eId/pixStatus no modelo → qualquer SELECT “cheio” quebra (P2022).
// Solução: sondar information_schema e usar getOrderScalarSelect() em queries que retornam pedidos.
// Sondagem: index.js / bootstrap/http.js após message-db-compat.

const prisma = require("./db");
const log = require("./logger").child({ module: "order-pix-db-compat" });

/** @type {boolean | null} null = ainda não sondado */
let orderPixColumnsPresent = null;

const PIX_COLS = ["pixTxid", "pixE2eId", "pixStatus"];

/** Campos escalares do model Order exceto os 3 PIX (espelha prisma/schema.prisma). */
const ORDER_SCALAR_WITHOUT_PIX = {
  id: true,
  tenantId: true,
  customerId: true,
  idempotencyKey: true,
  status: true,
  total: true,
  deliveryFee: true,
  discount: true,
  totalValidated: true,
  totalExpected: true,
  fulfillment: true,
  paymentMethodId: true,
  paymentMethodName: true,
  itemsSnapshot: true,
  addressSnapshot: true,
  cwOrderId: true,
  cwPayload: true,
  cwResponse: true,
  createdAt: true,
  updatedAt: true,
  cardapiowebStatus: true,
  statusChangedAt: true,
  timeInCurrentStatusMinutes: true,
  dailyAvgProdToOutMinutes: true,
  dailyAvgOutToDoneMinutes: true,
  estimatedRemainingMin: true,
  estimatedRemainingMax: true,
  weatherDelayFactor: true,
  delayAlertSentAt: true,
  secondDelayAlertSentAt: true,
  thirdDelayAlertSentAt: true,
  attendantAlertSentAt: true,
  watchedByAttendant: true,
  deliveryRiskLevel: true,
  compensationEligible: true,
  compensationReason: true,
  compensationType: true,
  couponCode: true,
  couponGeneratedAt: true,
  couponSentAt: true,
};

async function refreshOrderPixColumnSupport() {
  orderPixColumnsPresent = false;
  try {
    const rows = await prisma.$queryRaw`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'orders'
        AND column_name IN ('pixTxid', 'pixE2eId', 'pixStatus')
    `;
    const set = new Set((Array.isArray(rows) ? rows : []).map((r) => r.column_name));
    orderPixColumnsPresent = PIX_COLS.every((c) => set.has(c));
  } catch (err) {
    orderPixColumnsPresent = false;
    log.warn(
      { err: err.message },
      "orders PIX: falha ao consultar information_schema; assumindo colunas ausentes (modo degradado)",
    );
  }

  log.info(
    { orderPixColumnsPresent },
    "order-pix-db-compat: colunas PIX em public.orders",
  );

  if (!orderPixColumnsPresent) {
    log.error(
      "public.orders sem colunas PIX (pixTxid, pixE2eId, pixStatus). " +
        "O app roda em modo degradado (queries sem essas colunas). " +
        "Correção: aplique prisma/migrations/20260325120000_order_pix_fields/migration.sql ou `npx prisma migrate deploy`.",
    );
  }
}

function hasOrderPixColumns() {
  return orderPixColumnsPresent === true;
}

/** Para /health antes da sondagem terminar — evita “missing” falso-positivo. */
function getOrderPixColumnsHealth() {
  if (orderPixColumnsPresent === null) return "pending";
  return orderPixColumnsPresent ? "ok" : "missing";
}

function shouldDegradeForMissingOrderPixColumns() {
  return orderPixColumnsPresent === false;
}

/**
 * Select estável para findMany/findFirst/findUnique/create/update return — evita colunas PIX se não existirem.
 */
function getOrderScalarSelect() {
  const s = { ...ORDER_SCALAR_WITHOUT_PIX };
  if (hasOrderPixColumns()) {
    s.pixTxid = true;
    s.pixE2eId = true;
    s.pixStatus = true;
  }
  return s;
}

/** Mescla um select parcial do usuário com regras PIX (não remove chaves já definidas). */
function mergeOrderSelect(partial) {
  if (!partial || typeof partial !== "object") return getOrderScalarSelect();
  const base = getOrderScalarSelect();
  const out = { ...base, ...partial };
  if (!hasOrderPixColumns()) {
    delete out.pixTxid;
    delete out.pixE2eId;
    delete out.pixStatus;
  }
  return out;
}

/** Remove chaves PIX de `data` em updates/creates quando a coluna não existe. */
function omitPixFromOrderWriteData(data) {
  if (!data || typeof data !== "object" || hasOrderPixColumns()) return data;
  const out = { ...data };
  delete out.pixTxid;
  delete out.pixE2eId;
  delete out.pixStatus;
  return out;
}

module.exports = {
  refreshOrderPixColumnSupport,
  hasOrderPixColumns,
  getOrderPixColumnsHealth,
  shouldDegradeForMissingOrderPixColumns,
  getOrderScalarSelect,
  mergeOrderSelect,
  omitPixFromOrderWriteData,
};
