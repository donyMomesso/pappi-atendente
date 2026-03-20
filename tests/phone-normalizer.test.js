const { normalize, toLocal, format, fromWhatsApp } = require("../src/normalizers/PhoneNormalizer");

describe("PhoneNormalizer", () => {
  describe("normalize()", () => {
    it("should return null for empty/invalid input", () => {
      expect(normalize(null)).toBeNull();
      expect(normalize("")).toBeNull();
      expect(normalize(undefined)).toBeNull();
    });

    it("should normalize a Brazilian mobile with country code", () => {
      expect(normalize("5511999887766")).toBe("5511999887766");
    });

    it("should add country code 55 if missing", () => {
      expect(normalize("11999887766")).toBe("5511999887766");
    });

    it("should strip non-digit characters", () => {
      expect(normalize("+55 (11) 99988-7766")).toBe("5511999887766");
    });

    it("should handle landline numbers (8 digits after DDD)", () => {
      expect(normalize("551134567890")).toBe("551134567890");
    });

    it("should reject numbers with invalid DDD", () => {
      expect(normalize("5509999887766")).toBeNull();
      expect(normalize("5500999887766")).toBeNull();
    });

    it("should reject too short or too long numbers", () => {
      expect(normalize("55119")).toBeNull();
      expect(normalize("551199988776612345")).toBeNull();
    });

    it("should handle double country code prefix", () => {
      expect(normalize("555511999887766")).toBe("5511999887766");
    });
  });

  describe("toLocal()", () => {
    it("should remove country code 55", () => {
      expect(toLocal("5511999887766")).toBe("11999887766");
    });

    it("should return null for invalid input", () => {
      expect(toLocal(null)).toBeNull();
      expect(toLocal("")).toBeNull();
    });
  });

  describe("format()", () => {
    it("should format a mobile number", () => {
      expect(format("5511999887766")).toBe("(11) 99988-7766");
    });

    it("should format a landline number", () => {
      expect(format("551134567890")).toBe("(11) 3456-7890");
    });

    it("should return raw input if not normalizable", () => {
      expect(format("abc")).toBe("abc");
    });
  });

  describe("fromWhatsApp()", () => {
    it("should normalize WhatsApp ID", () => {
      expect(fromWhatsApp("5511999887766")).toBe("5511999887766");
    });
  });
});
