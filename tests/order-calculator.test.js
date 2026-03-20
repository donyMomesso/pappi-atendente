const { calculate, validate, calcItemSubtotal, round2 } = require("../src/calculators/OrderCalculator");

describe("OrderCalculator", () => {
  describe("round2()", () => {
    it("should round to 2 decimal places", () => {
      expect(round2(1.005)).toBe(1);
      expect(round2(10.999)).toBe(11);
      expect(round2(0)).toBe(0);
      expect(round2(null)).toBe(0);
    });
  });

  describe("calcItemSubtotal()", () => {
    it("should calculate simple item subtotal", () => {
      const result = calcItemSubtotal({ unit_price: 10, quantity: 2 });
      expect(result).toBe(20);
    });

    it("should include addons in subtotal", () => {
      const result = calcItemSubtotal({
        unit_price: 10,
        quantity: 2,
        addons: [
          { unit_price: 2, quantity: 1 },
          { unit_price: 3, quantity: 1 },
        ],
      });
      expect(result).toBe(30);
    });

    it("should handle items with no addons", () => {
      const result = calcItemSubtotal({ unit_price: 15.5, quantity: 1, addons: [] });
      expect(result).toBe(15.5);
    });
  });

  describe("calculate()", () => {
    it("should calculate order total with items, fee, and discount", () => {
      const result = calculate({
        items: [
          { id: "1", name: "Pizza", unit_price: 30, quantity: 2 },
          { id: "2", name: "Soda", unit_price: 5, quantity: 1 },
        ],
        deliveryFee: 8,
        discount: 5,
      });
      expect(result.itemsTotal).toBe(65);
      expect(result.deliveryFee).toBe(8);
      expect(result.discount).toBe(5);
      expect(result.expectedTotal).toBe(68);
      expect(result.breakdown).toHaveLength(2);
    });

    it("should handle empty items", () => {
      const result = calculate({ items: [], deliveryFee: 0, discount: 0 });
      expect(result.itemsTotal).toBe(0);
      expect(result.expectedTotal).toBe(0);
    });
  });

  describe("validate()", () => {
    it("should validate correct total", () => {
      const result = validate({
        items: [{ id: "1", name: "Pizza", unit_price: 30, quantity: 1 }],
        declaredTotal: 38,
        deliveryFee: 8,
        discount: 0,
      });
      expect(result.ok).toBe(true);
      expect(result.expected).toBe(38);
    });

    it("should reject incorrect total beyond tolerance", () => {
      const result = validate({
        items: [{ id: "1", name: "Pizza", unit_price: 30, quantity: 1 }],
        declaredTotal: 50,
        deliveryFee: 0,
        discount: 0,
      });
      expect(result.ok).toBe(false);
      expect(result.diff).toBeGreaterThan(0.02);
    });

    it("should accept total within tolerance (0.02)", () => {
      const result = validate({
        items: [{ id: "1", name: "Pizza", unit_price: 30, quantity: 1 }],
        declaredTotal: 30.01,
        deliveryFee: 0,
        discount: 0,
      });
      expect(result.ok).toBe(true);
    });
  });
});
