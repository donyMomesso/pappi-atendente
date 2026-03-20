const { normalize, fromText } = require("../src/normalizers/AddressNormalizer");

describe("AddressNormalizer", () => {
  describe("normalize()", () => {
    it("should normalize a valid address", () => {
      const result = normalize({
        street: "Rua das Flores",
        number: "123",
        neighborhood: "Centro",
        city: "Campinas",
        state: "SP",
        cep: "13010000",
      });
      expect(result.ok).toBe(true);
      expect(result.address.street).toBe("Rua das Flores");
      expect(result.address.number).toBe("123");
      expect(result.address.city).toBe("Campinas");
      expect(result.address.state).toBe("SP");
    });

    it("should return errors for missing required fields", () => {
      const result = normalize({ number: "10" });
      expect(result.ok).toBe(false);
      expect(result.errors).toContain("Rua obrigatória");
      expect(result.errors).toContain("Bairro obrigatório");
      expect(result.errors).toContain("Cidade obrigatória");
    });

    it("should reject invalid UF", () => {
      const result = normalize({
        street: "Rua A",
        number: "1",
        neighborhood: "B",
        city: "C",
        state: "XX",
      });
      expect(result.ok).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([expect.stringMatching(/UF inválida/)]));
    });

    it("should accept alternative field names", () => {
      const result = normalize({
        rua: "Av Brasil",
        numero: "500",
        bairro: "Jardim",
        cidade: "São Paulo",
        uf: "SP",
      });
      expect(result.ok).toBe(true);
      expect(result.address.street).toBe("Av Brasil");
    });

    it("should return error for null input", () => {
      const result = normalize(null);
      expect(result.ok).toBe(false);
    });
  });

  describe("fromText()", () => {
    it("should extract street and number from text", () => {
      const result = fromText("Rua das Flores, 123");
      expect(result.street).toBe("Rua das Flores");
      expect(result.number).toBe("123");
    });

    it("should return null for empty input", () => {
      expect(fromText(null)).toBeNull();
      expect(fromText("")).toBeNull();
    });

    it("should extract CEP from text", () => {
      const result = fromText("Rua A, 10, 13010-000");
      expect(result.zipCode).toBe("13010000");
    });

    it("should default number to S/N when missing", () => {
      const result = fromText("Rua sem número");
      expect(result.number).toBe("S/N");
    });
  });
});
