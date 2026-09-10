import { describe, expect, it } from "vitest";
import { buildWhatsAppUrl, buildTelHref, normalizeWhatsappNumber } from "@/lib/support/contact";

describe("support contact builders", () => {
  describe("normalizeWhatsappNumber", () => {
    it("keeps a plain international number as digits", () => {
      expect(normalizeWhatsappNumber("+212600112233")).toBe("212600112233");
      expect(normalizeWhatsappNumber("212 600 11 22 33")).toBe("212600112233");
      expect(normalizeWhatsappNumber("(212) 600-112-233")).toBe("212600112233");
    });

    it("strips a leading 00 international prefix", () => {
      expect(normalizeWhatsappNumber("00212600112233")).toBe("212600112233");
    });

    it("returns null for empty or implausible input", () => {
      expect(normalizeWhatsappNumber("")).toBeNull();
      expect(normalizeWhatsappNumber(null)).toBeNull();
      expect(normalizeWhatsappNumber("12345")).toBeNull(); // too short
      expect(normalizeWhatsappNumber("1".repeat(20))).toBeNull(); // too long
    });
  });

  describe("buildWhatsAppUrl", () => {
    it("builds a wa.me link with an encoded prefilled message", () => {
      const url = buildWhatsAppUrl("+212600112233", "Bonjour, j'ai besoin d'aide.");
      expect(url).toBe("https://wa.me/212600112233?text=Bonjour%2C%20j'ai%20besoin%20d'aide.");
    });

    it("omits the query when there is no message", () => {
      expect(buildWhatsAppUrl("212600112233")).toBe("https://wa.me/212600112233");
    });

    it("returns null when the number is missing or invalid, so the action can be hidden", () => {
      expect(buildWhatsAppUrl("", "hi")).toBeNull();
      expect(buildWhatsAppUrl(null)).toBeNull();
      expect(buildWhatsAppUrl("abc")).toBeNull();
    });
  });

  describe("buildTelHref", () => {
    it("keeps a leading + and digits only", () => {
      expect(buildTelHref("+212 600-11-22-33")).toBe("tel:+212600112233");
      expect(buildTelHref("0600112233")).toBe("tel:0600112233");
    });

    it("returns null for missing or unusable input", () => {
      expect(buildTelHref("")).toBeNull();
      expect(buildTelHref(null)).toBeNull();
      expect(buildTelHref("12")).toBeNull();
    });

    it("is independent of WhatsApp — a phone number is not a WhatsApp number", () => {
      // Same digits, two separate builders — the widget renders them as
      // separate actions from separate config fields.
      const phone = "+212522334455";
      expect(buildTelHref(phone)).toBe("tel:+212522334455");
      expect(buildWhatsAppUrl(phone)).toBe("https://wa.me/212522334455");
    });
  });
});
