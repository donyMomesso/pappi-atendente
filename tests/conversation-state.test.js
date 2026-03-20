/**
 * Testes do fluxo híbrido — conversation-state.service
 */
const convState = require("../src/services/conversation-state.service");

describe("conversation-state", () => {
  describe("STATES", () => {
    it("deve ter os 4 estados do fluxo híbrido", () => {
      expect(convState.STATES.BOT_ATIVO).toBe("bot_ativo");
      expect(convState.STATES.AGUARDANDO_HUMANO).toBe("aguardando_humano");
      expect(convState.STATES.HUMANO_ATIVO).toBe("humano_ativo");
      expect(convState.STATES.ENCERRADO).toBe("encerrado");
    });
  });

  describe("getState (derivação handoff/claimedBy)", () => {
    const prisma = require("../src/lib/db");
    const originalFindUnique = prisma.config.findUnique;

    afterEach(() => {
      prisma.config.findUnique = originalFindUnique;
    });

    it("retorna bot_ativo quando handoff=false e sem Config", async () => {
      prisma.config.findUnique = jest.fn().mockResolvedValue(null);
      const customer = { id: "c1", handoff: false, claimedBy: null };
      const state = await convState.getState(customer);
      expect(state).toBe("bot_ativo");
    });

    it("retorna aguardando_humano quando handoff=true e claimedBy=null", async () => {
      prisma.config.findUnique = jest.fn().mockResolvedValue(null);
      const customer = { id: "c2", handoff: true, claimedBy: null };
      const state = await convState.getState(customer);
      expect(state).toBe("aguardando_humano");
    });

    it("retorna humano_ativo quando handoff=true e claimedBy definido", async () => {
      prisma.config.findUnique = jest.fn().mockResolvedValue(null);
      const customer = { id: "c3", handoff: true, claimedBy: "Maria" };
      const state = await convState.getState(customer);
      expect(state).toBe("humano_ativo");
    });

    it("retorna estado da Config quando existe", async () => {
      prisma.config.findUnique = jest.fn().mockResolvedValue({
        value: JSON.stringify({ state: "encerrado", updatedAt: new Date().toISOString() }),
      });
      const customer = { id: "c4", handoff: false, claimedBy: null };
      const state = await convState.getState(customer);
      expect(state).toBe("encerrado");
    });
  });

  describe("shouldBotRespond", () => {
    const prisma = require("../src/lib/db");
    const originalFindUnique = prisma.config.findUnique;

    afterEach(() => {
      prisma.config.findUnique = originalFindUnique;
    });

    it("retorna true para bot_ativo", async () => {
      prisma.config.findUnique = jest.fn().mockResolvedValue({
        value: JSON.stringify({ state: "bot_ativo" }),
      });
      const customer = { id: "c5" };
      expect(await convState.shouldBotRespond(customer)).toBe(true);
    });

    it("retorna false para humano_ativo", async () => {
      prisma.config.findUnique = jest.fn().mockResolvedValue(null);
      const customer = { id: "c6", handoff: true, claimedBy: "João" };
      expect(await convState.shouldBotRespond(customer)).toBe(false);
    });

    it("retorna false para aguardando_humano", async () => {
      prisma.config.findUnique = jest.fn().mockResolvedValue(null);
      const customer = { id: "c7", handoff: true, claimedBy: null };
      expect(await convState.shouldBotRespond(customer)).toBe(false);
    });
  });

  describe("resetIfEncerrado", () => {
    const prisma = require("../src/lib/db");
    let findUniqueMock, upsertMock;

    beforeEach(() => {
      findUniqueMock = jest.fn();
      upsertMock = jest.fn().mockResolvedValue({});
      prisma.config.findUnique = findUniqueMock;
      prisma.config.upsert = upsertMock;
    });

    afterEach(() => {
      prisma.config.findUnique = require("../src/lib/db").config?.findUnique;
      prisma.config.upsert = require("../src/lib/db").config?.upsert;
    });

    it("retorna true e chama setState quando estado é encerrado", async () => {
      findUniqueMock
        .mockResolvedValueOnce({
          value: JSON.stringify({ state: "encerrado" }),
        })
        .mockResolvedValueOnce({ value: JSON.stringify({ state: "encerrado" }) });
      const customer = { id: "c8" };
      const result = await convState.resetIfEncerrado(customer);
      expect(result).toBe(true);
      expect(upsertMock).toHaveBeenCalled();
    });

    it("retorna false quando estado não é encerrado", async () => {
      findUniqueMock.mockResolvedValue({
        value: JSON.stringify({ state: "bot_ativo" }),
      });
      const customer = { id: "c9" };
      const result = await convState.resetIfEncerrado(customer);
      expect(result).toBe(false);
      expect(upsertMock).not.toHaveBeenCalled();
    });
  });
});
