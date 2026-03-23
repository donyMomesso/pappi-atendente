const { check, checkWebhook, checkGemini, checkOrder, LIMITS, stopCleanup } = require("../src/lib/rate-limiter");

describe("rate-limiter", () => {
  afterAll(() => stopCleanup());
  describe("check()", () => {
    it("should allow first request", () => {
      const result = check("test-first", { windowMs: 60000, max: 5 });
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
      expect(result.resetIn).toBe(0);
    });

    it("should decrement remaining on each call", () => {
      const key = "test-decrement-" + Date.now();
      const opts = { windowMs: 60000, max: 3 };
      const r1 = check(key, opts);
      const r2 = check(key, opts);
      const r3 = check(key, opts);
      expect(r1.remaining).toBe(2);
      expect(r2.remaining).toBe(1);
      expect(r3.remaining).toBe(0);
    });

    it("should block when limit is exceeded", () => {
      const key = "test-block-" + Date.now();
      const opts = { windowMs: 60000, max: 2 };
      check(key, opts);
      check(key, opts);
      const blocked = check(key, opts);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.resetIn).toBeGreaterThan(0);
    });
  });

  describe("LIMITS config", () => {
    it("should have webhook, gemini, and order limits defined", () => {
      expect(LIMITS.webhook.windowMs).toBe(60000);
      expect(LIMITS.webhook.max).toBeGreaterThanOrEqual(30);
      expect(LIMITS.gemini.windowMs).toBe(60000);
      expect(LIMITS.order.windowMs).toBe(600000);
    });
  });

  describe("checkWebhook()", () => {
    it("should allow first webhook request", () => {
      const result = checkWebhook("5511999990001");
      expect(result.allowed).toBe(true);
    });
  });

  describe("checkGemini()", () => {
    it("should allow first gemini request", () => {
      const result = checkGemini("5511999990002");
      expect(result.allowed).toBe(true);
    });
  });

  describe("checkOrder()", () => {
    it("should allow first order request", () => {
      const result = checkOrder("5511999990003");
      expect(result.allowed).toBe(true);
    });
  });
});
