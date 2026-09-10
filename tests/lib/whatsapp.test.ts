import { describe, expect, it } from "vitest";
import { toMoroccanWhatsAppDigits, buildCustomerWhatsAppUrl } from "@/lib/whatsapp";

describe("toMoroccanWhatsAppDigits", () => {
  it("converts local 0X format to international", () => {
    expect(toMoroccanWhatsAppDigits("0612345678")).toBe("212612345678");
  });
  it("keeps an already-international number as-is", () => {
    expect(toMoroccanWhatsAppDigits("+212612345678")).toBe("212612345678");
    expect(toMoroccanWhatsAppDigits("212612345678")).toBe("212612345678");
  });
  it("adds the country code to a bare 9-digit number", () => {
    expect(toMoroccanWhatsAppDigits("612345678")).toBe("212612345678");
  });
  it("strips spaces and separators", () => {
    expect(toMoroccanWhatsAppDigits("06 12 34 56 78")).toBe("212612345678");
  });
});

describe("buildCustomerWhatsAppUrl", () => {
  it("builds a wa.me link with the pre-filled message encoded", () => {
    const url = buildCustomerWhatsAppUrl("0612345678", "Bonjour Amina");
    expect(url).toBe("https://wa.me/212612345678?text=Bonjour%20Amina");
  });

  it("builds a link with no message when none is given", () => {
    expect(buildCustomerWhatsAppUrl("0612345678")).toBe("https://wa.me/212612345678");
  });

  it("returns null for missing or unusable numbers", () => {
    expect(buildCustomerWhatsAppUrl(null)).toBeNull();
    expect(buildCustomerWhatsAppUrl("")).toBeNull();
    expect(buildCustomerWhatsAppUrl("123")).toBeNull();
  });
});
