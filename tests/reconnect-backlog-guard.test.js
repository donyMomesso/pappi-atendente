jest.mock("../src/lib/db", () => ({}));
jest.mock("../src/services/baileys-db-auth", () => ({
  useDbAuthState: () => ({}),
  clearDbAuth: async () => {},
  listInstances: async () => [],
}));
jest.mock("../src/services/baileys-lock.service", () => ({
  acquireLock: async () => true,
}));
jest.mock("../src/config/env", () => ({
  APP_ENV: "test",
}));
jest.mock("@whiskeysockets/baileys", () => ({
  default: () => ({}),
  DisconnectReason: {},
  fetchLatestBaileysVersion: async () => ({ version: [2, 2304, 6] }),
}));

const { _test } = require("../src/services/baileys.service");

function makeMsgWithSecondsAgo(secondsAgo) {
  const ms = Date.now() - secondsAgo * 1000;
  const seconds = Math.floor(ms / 1000);
  return { messageTimestamp: seconds };
}

describe("reconnect/backlog guard", () => {
  beforeEach(() => {
    _test.resetReconnectCaches();
  });

  test("resolveBaileysOriginalTimestamp: aceita number (seconds)", () => {
    const msg = { messageTimestamp: 1700000000 };
    const d = _test.resolveBaileysOriginalTimestamp(msg);
    expect(d instanceof Date).toBe(true);
    expect(Number.isFinite(d.getTime())).toBe(true);
  });

  test("isMessageWithinLast24h: true no window e false fora", () => {
    const now = Date.now();
    const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
    try {
      // 23h atrás: deve ser true
      expect(_test.isMessageWithinLast24h({ messageTimestamp: Math.floor((now - 23 * 3600_000) / 1000) })).toBe(true);
      // 25h atrás: false
      expect(_test.isMessageWithinLast24h({ messageTimestamp: Math.floor((now - 25 * 3600_000) / 1000) })).toBe(false);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("isFreshForBot: true dentro de 15min e false fora", () => {
    const now = Date.now();
    const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
    try {
      // 90s atrás (1.5min): true
      expect(_test.isFreshForBot({ messageTimestamp: Math.floor((now - 90 * 1000) / 1000) })).toBe(true);
      // 3min atrás: true (janela atual é 15min)
      expect(_test.isFreshForBot({ messageTimestamp: Math.floor((now - 3 * 60 * 1000) / 1000) })).toBe(true);
      // 16min atrás: false
      expect(_test.isFreshForBot({ messageTimestamp: Math.floor((now - 16 * 60 * 1000) / 1000) })).toBe(false);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("shouldSendReconnectNotice e suppress: cooldown + janela 90s", () => {
    const id = "tenant:cust_fuzz|5511999999999|5511999999999@s.whatsapp.net";
    const base = 1700000100000;
    const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => base);
    try {
      // primeira vez
      expect(_test.shouldSendReconnectNotice(id)).toBe(true);
      // dentro do cooldown (5min): false
      nowSpy.mockImplementation(() => base + 60_000);
      expect(_test.shouldSendReconnectNotice(id)).toBe(false);

      // suppress ativa por 90s
      nowSpy.mockImplementation(() => base + 30_000);
      expect(_test.isReconnectSuppressed(id)).toBe(true);

      // após 91s da primeira notificação: supress já acabou
      nowSpy.mockImplementation(() => base + 91_000);
      expect(_test.isReconnectSuppressed(id)).toBe(false);

      // após cooldown: pode enviar novamente
      nowSpy.mockImplementation(() => base + 6 * 60_000);
      expect(_test.shouldSendReconnectNotice(id)).toBe(true);
      expect(_test.isReconnectSuppressed(id)).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

