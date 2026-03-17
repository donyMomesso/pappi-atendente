// src/calculators/OrderCalculator.js
// Req 2 — Validar totais do pedido para evitar discrepâncias

/**
 * Calcula e valida o total de um pedido.
 *
 * Estrutura esperada de item:
 * {
 *   id:           string,
 *   name:         string,
 *   quantity:     number,
 *   unit_price:   number,   // preço unitário em reais
 *   addons:       Array<{ name, quantity, unit_price }>,  // opcionais
 * }
 */

const TOLERANCE = 0.02; // R$ 0,02 de tolerância por arredondamento

/**
 * Calcula o subtotal de um item (com addons).
 */
function calcItemSubtotal(item) {
  const base = round2(item.unit_price * item.quantity);
  const addonsTotal = (item.addons || []).reduce((sum, a) => {
    return sum + round2(a.unit_price * (a.quantity || 1) * item.quantity);
  }, 0);
  return round2(base + addonsTotal);
}

/**
 * Calcula o total esperado de um pedido.
 *
 * @param {object} opts
 * @param {Array}  opts.items          Lista de itens
 * @param {number} [opts.deliveryFee]  Taxa de entrega
 * @param {number} [opts.discount]     Desconto (valor positivo)
 * @returns {{ itemsTotal, deliveryFee, discount, expectedTotal, breakdown }}
 */
function calculate({ items = [], deliveryFee = 0, discount = 0 }) {
  const breakdown = items.map((item) => ({
    id: item.id,
    name: item.name,
    quantity: item.quantity,
    unit_price: item.unit_price,
    subtotal: calcItemSubtotal(item),
  }));

  const itemsTotal = round2(breakdown.reduce((s, b) => s + b.subtotal, 0));
  const expectedTotal = round2(itemsTotal + deliveryFee - discount);

  return {
    itemsTotal,
    deliveryFee: round2(deliveryFee),
    discount: round2(discount),
    expectedTotal,
    breakdown,
  };
}

/**
 * Valida se o total declarado bate com o calculado.
 *
 * @param {object} opts
 * @param {Array}  opts.items
 * @param {number} opts.declaredTotal   Total que o sistema externo (CW) retornou
 * @param {number} [opts.deliveryFee]
 * @param {number} [opts.discount]
 * @returns {{ ok: boolean, expected: number, declared: number, diff: number, detail: object }}
 */
function validate({ items, declaredTotal, deliveryFee = 0, discount = 0 }) {
  const calc = calculate({ items, deliveryFee, discount });
  const diff = Math.abs(round2(calc.expectedTotal - declaredTotal));

  return {
    ok: diff <= TOLERANCE,
    expected: calc.expectedTotal,
    declared: round2(declaredTotal),
    diff,
    detail: calc,
  };
}

function round2(n) {
  return Math.round((n || 0) * 100) / 100;
}

module.exports = { calculate, validate, calcItemSubtotal, round2 };
