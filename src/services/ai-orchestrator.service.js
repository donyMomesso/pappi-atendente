// src/services/ai-orchestrator.service.js
// FASE 1 — Orquestração consultiva do fluxo conversacional.
// Não define preço, payment_method_id, payload CW ou totais — só organiza decisão de UX e sinais de aprendizado.
//
// Entrada: triagem (inbox-triage), intake (order-intake), snapshot da sessão, perfil mínimo do cliente, histórico recente.
// Saída: modeFinal, nextBestAction, nextQuestion, missingFields, confidence, learningSignals.
//
// Implementação atual: fusão determinística (rule_v1). Gancho futuro: LLM com o mesmo contrato de JSON + validação.

const log = require("../lib/logger").child({ service: "ai-orchestrator" });

/** Campos seguros da sessão — sem credenciais, sem totais monetários confiáveis (apenas flags de progresso). */
function snapshotSession(session) {
  if (!session || typeof session !== "object") return {};
  return {
    mode: session.mode,
    step: session.step,
    productType: session.productType || null,
    fulfillment: session.fulfillment || null,
    chosenSize: session.chosenSize || null,
    isLeadOrder: !!session.isLeadOrder,
    cartItemCount: Array.isArray(session.cart) ? session.cart.length : 0,
    hasAddress: !!session.address,
    paymentMethodChosen: !!(session.paymentMethodId || session.paymentMethodName),
    customerName: session.customerName || session.name || null,
    deescalation: session.step === "DEESCALATION",
  };
}

function uniqueStrings(arr) {
  return [...new Set((arr || []).filter(Boolean).map(String))];
}

function missingFromSessionStep(session) {
  const step = session?.step;
  const out = [];
  if (!step) return out;
  switch (step) {
    case "MENU":
    case "CHOOSE_PRODUCT_TYPE":
      if (!session.productType) out.push("product_type");
      break;
    case "ASK_NAME":
      out.push("customer_name");
      break;
    case "FULFILLMENT":
      if (!session.fulfillment) out.push("fulfillment");
      break;
    case "ASK_SIZE":
      if (!session.chosenSize) out.push("size");
      break;
    case "ADDRESS":
    case "ADDRESS_NUMBER":
    case "ADDRESS_CONFIRM":
      if (session.fulfillment === "delivery" && !session.address) out.push("address");
      break;
    case "ORDERING":
      if (!session.cart?.length) out.push("items");
      break;
    case "PAYMENT":
      if (!session.paymentMethodId && !session.paymentMethodName) out.push("payment_method_choice");
      break;
    case "CONFIRM":
      out.push("order_confirmation");
      break;
    default:
      break;
  }
  return out;
}

/**
 * Mapeia intent de triagem + sessão para ação de alto nível (sem alterar integrações).
 */
function resolveNextBestAction(session, tri) {
  const mode = session?.mode;
  const step = session?.step;

  if (tri?.intent === "HUMAN") return "HANDOFF";
  if (tri?.intent === "ORDER_STATUS") return "STATUS_QUERY";
  if (tri?.intent === "MENU") return "FAQ_MENU";
  if (tri?.intent === "COMPLAINT") return "COMPLAINT_HANDOFF";
  if (tri?.intent === "DRIVER") return "DRIVER_ACK";

  if (tri?.shouldWaitMore && ["MENU", "CHOOSE_PRODUCT_TYPE", "FULFILLMENT"].includes(step)) {
    return "BUFFER_WAIT";
  }

  if (mode === "TRIAGE" && tri?.intent === "OTHER") return "TRIAGE_CHOICE";

  if (mode === "ORDER") {
    if (step === "PAYMENT") return "PAYMENT_SELECT";
    if (step === "CONFIRM") return "CONFIRM_ORDER";
    if (step === "ORDERING") return "COLLECT_ITEMS";
    if (["ADDRESS", "ADDRESS_NUMBER", "ADDRESS_CONFIRM"].includes(step)) return "ADDRESS_COLLECT";
    if (step === "ASK_SIZE") return "ASK_SIZE";
    if (step === "FULFILLMENT") return "ASK_FULFILLMENT";
    if (step === "ASK_NAME") return "ASK_NAME";
    if (step === "CHOOSE_PRODUCT_TYPE" || step === "MENU") return "PRODUCT_TYPE";
    return "CONTINUE_ORDER_FUNNEL";
  }

  if (mode === "FAQ") return "FAQ_CONTINUE";
  if (mode === "STATUS") return "STATUS_QUERY";
  if (mode === "HUMAN") return "HANDOFF";

  return "CONTINUE_FUNNEL";
}

function hintNextQuestion(session, tri, intake) {
  const step = session?.step;
  const mode = session?.mode;

  if (tri?.intent === "HUMAN") return "Transferir para atendente humano.";
  if (tri?.intent === "ORDER_STATUS") return "Consultar status do último pedido.";
  if (tri?.intent === "MENU") return "Informar link do cardápio ou opções do menu.";
  if (tri?.intent === "COMPLAINT") return "Acionar humano com contexto de reclamação.";
  if (tri?.intent === "DRIVER") return "Pedir referência do pedido ao entregador.";

  if (tri?.shouldWaitMore) return "Aguardar mais texto (mensagem fragmentada).";

  if (mode === "TRIAGE" && tri?.intent === "OTHER") return "Oferecer botões de triagem (pedido / status / cardápio / humano).";

  if (mode === "ORDER") {
    if (step === "CHOOSE_PRODUCT_TYPE") return "Perguntar pizza ou lasanha.";
    if (step === "ASK_NAME") return "Pedir nome para o pedido.";
    if (step === "FULFILLMENT") return "Perguntar entrega ou retirada.";
    if (step === "ASK_SIZE") return "Perguntar tamanho.";
    if (step === "ADDRESS" || step === "ADDRESS_NUMBER") return "Coletar endereço ou número.";
    if (step === "ORDERING") return "Interpretar itens com catálogo (fluxo existente).";
    if (step === "PAYMENT") return "Oferecer meios de pagamento do tenant (mapper).";
    if (step === "CONFIRM") return "Pedir confirmação explícita do resumo.";
  }

  if (intake?.hasCompleteOrder) return "Avançar funil: dados do pedido parecem completos no texto.";
  return "Seguir etapa atual do funil.";
}

function blendConfidence(tri, intake) {
  const t = typeof tri?.confidence === "number" ? tri.confidence : 0.5;
  if (!intake) return Math.max(0, Math.min(1, t));
  const i = typeof intake.confidence === "number" ? intake.confidence : 0.5;
  return Math.max(0, Math.min(1, t * 0.55 + i * 0.45));
}

function historySignals(history) {
  const msgs = Array.isArray(history) ? history : [];
  const userMsgs = msgs.filter((m) =>
    ["user", "customer"].includes(String(m.role || "").toLowerCase()),
  );
  const turns = userMsgs.length;
  const lastTexts = userMsgs.slice(-4).map((m) => String(m.text || "").trim().toLowerCase());
  let repeatedPattern = false;
  if (lastTexts.length >= 2) {
    const last = lastTexts[lastTexts.length - 1];
    repeatedPattern = lastTexts.slice(0, -1).some((x) => x === last && last.length > 0);
  }
  return { turns, repeatedUserPhrase: repeatedPattern };
}

/**
 * @param {object} params
 * @param {string} params.tenantId
 * @param {object} params.customer — { id, name?, visitCount?, preferredPayment?, handoff? }
 * @param {object} params.session — sessão completa (será sanitizada)
 * @param {string} [params.text] — última mensagem do usuário
 * @param {Array<{role:string,text:string,at?:string}>} [params.history]
 * @param {object|null} [params.triageResult] — retorno de inbox-triage
 * @param {object|null} [params.intakeResult] — retorno de order-intake
 */
async function decideOrchestration(params = {}) {
  const { tenantId, customer, session, text, history, triageResult, intakeResult } = params;
  const shot = snapshotSession(session);
  const modeFinal = shot.mode || "TRIAGE";

  const missIntake = Array.isArray(intakeResult?.missing) ? intakeResult.missing : [];
  const missStep = missingFromSessionStep(session);
  const missingFields = uniqueStrings([...missIntake, ...missStep]);

  const nextBestAction = resolveNextBestAction(session, triageResult);
  const nextQuestion = hintNextQuestion(session, triageResult, intakeResult);
  const confidence = blendConfidence(triageResult, session?.mode === "ORDER" ? intakeResult : null);

  const histS = historySignals(history);
  const learningSignals = {
    tenantId: tenantId || null,
    customerId: customer?.id || null,
    triageIntent: triageResult?.intent || null,
    triageConfidence: triageResult?.confidence ?? null,
    fragmented: !!triageResult?.fragmented,
    shouldWaitMore: !!triageResult?.shouldWaitMore,
    intakeCompleteness: intakeResult?.completenessScore ?? null,
    intakeIsOrder: !!intakeResult?.isOrder,
    sessionStep: shot.step || null,
    orderProgress: shot,
    repeatVisitor: (customer?.visitCount || 0) > 1,
    preferredPaymentHint: customer?.preferredPayment || null,
    handoffFlag: !!customer?.handoff,
    historyTurns: histS.turns,
    repeatedUserPhrase: histS.repeatedUserPhrase,
    lastUserTextLen: String(text || "").length,
  };

  const out = {
    modeFinal,
    nextBestAction,
    nextQuestion,
    missingFields,
    confidence,
    learningSignals,
    meta: {
      engine: "rule_v1",
      at: new Date().toISOString(),
    },
  };

  log.debug(
    {
      tenantId,
      modeFinal,
      nextBestAction,
      confidence: Math.round(confidence * 100) / 100,
    },
    "Orquestração (consultiva)",
  );

  return out;
}

module.exports = {
  decideOrchestration,
  snapshotSession,
};
