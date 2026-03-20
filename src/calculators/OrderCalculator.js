// src/calculators/OrderCalculator.js

const TOLERANCE = 0.02;

function calcItemSubtotal(item) {
  const base = round2(item.unit_price * item.quantity);
  const addonsTotal = (item.addons || []).reduce((sum, a) => {
    return sum + round2(a.unit_price * (a.quantity || 1) * item.quantity);
  }, 0);
  return round2(base + addonsTotal);
}

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
  return { itemsTotal, deliveryFee: round2(deliveryFee), discount: round2(discount), expectedTotal, breakdown };
}

function validate({ items, declaredTotal, deliveryFee = 0, discount = 0 }) {
  const calc = calculate({ items, deliveryFee, discount });
  const diff = Math.abs(round2(calc.expectedTotal - declaredTotal));
  return { ok: diff <= TOLERANCE, expected: calc.expectedTotal, declared: round2(declaredTotal), diff, detail: calc };
}

function round2(n) {
  return Math.round((n || 0) * 100) / 100;
}

module.exports = { calculate, validate, calcItemSubtotal, round2 };
