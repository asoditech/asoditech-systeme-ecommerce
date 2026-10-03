import { describe, expect, it } from "vitest";
import { phoneTelHref, phoneWhatsAppHref } from "@/lib/phone-links";

/**
 * Click-to-call / click-to-WhatsApp for stored contact numbers
 * (src/components/phone-actions.tsx). The stored value is never changed;
 * no country code is ever invented.
 */

describe("phoneTelHref", () => {
  it("keeps the number as stored (digits and a leading +), no country code added", () => {
    expect(phoneTelHref("06 12-34 56 78")).toBe("tel:0612345678");
    expect(phoneTelHref("+212 6 12 34 56 78")).toBe("tel:+212612345678");
    expect(phoneTelHref("(0522) 00 00 00")).toBe("tel:0522000000");
  });

  it("returns null for empty or unusable values", () => {
    expect(phoneTelHref(null)).toBeNull();
    expect(phoneTelHref("")).toBeNull();
    expect(phoneTelHref("abc")).toBeNull();
    expect(phoneTelHref("123")).toBeNull();
  });
});

describe("phoneWhatsAppHref", () => {
  it("international numbers are used as-is (+, 00, or 212 with 12 digits)", () => {
    expect(phoneWhatsAppHref("+212 6 12 34 56 78")).toBe("https://wa.me/212612345678");
    expect(phoneWhatsAppHref("00212612345678")).toBe("https://wa.me/212612345678");
    expect(phoneWhatsAppHref("212612345678")).toBe("https://wa.me/212612345678");
    expect(phoneWhatsAppHref("+33 6 12 34 56 78")).toBe("https://wa.me/33612345678");
  });

  it("a Moroccan national number (0 + 5/6/7 + 8 digits) follows the fixed national rule", () => {
    expect(phoneWhatsAppHref("06 12 34 56 78")).toBe("https://wa.me/212612345678");
    expect(phoneWhatsAppHref("0712345678")).toBe("https://wa.me/212712345678");
    expect(phoneWhatsAppHref("0522000000")).toBe("https://wa.me/212522000000");
  });

  it("never invents a country code: ambiguous numbers get no WhatsApp link", () => {
    expect(phoneWhatsAppHref("612345678")).toBeNull(); // bare 9 digits
    expect(phoneWhatsAppHref("0812345678")).toBeNull(); // not a 05/06/07 national number
    expect(phoneWhatsAppHref("12345")).toBeNull();
    expect(phoneWhatsAppHref("")).toBeNull();
    expect(phoneWhatsAppHref(undefined)).toBeNull();
  });

  it("only ever produces a digits-only wa.me URL", () => {
    for (const raw of ["+212 6-12/34 56 78", "00 212 612 345 678", "06.12.34.56.78"]) {
      expect(phoneWhatsAppHref(raw)).toMatch(/^https:\/\/wa\.me\/\d{8,15}$/);
    }
  });
});
