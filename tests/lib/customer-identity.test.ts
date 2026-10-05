import { describe, expect, it } from "vitest";
import {
  customerNameKey,
  customerPhoneKey,
  isPlaceholderCustomerName,
  isSameCustomerIdentity,
  maskCustomerPhone,
  customerPhoneSearchKeys,
} from "@/lib/customers/identity";

describe("customerPhoneKey", () => {
  it("every formatting of the same Moroccan number gives one key", () => {
    for (const raw of ["0612345678", "+212612345678", "212612345678", "06 12 34 56 78", "06-12-34-56-78", "00212612345678", "+212 6 12 34 56 78", "612345678", " 06.12.34.56.78 "]) {
      expect(customerPhoneKey(raw), raw).toBe("212612345678");
    }
  });
  it("landlines (05) and 07 numbers are valid Moroccan numbers", () => {
    expect(customerPhoneKey("0522123456")).toBe("212522123456");
    expect(customerPhoneKey("0700000000")).toBe("212700000000");
  });
  it("international numbers are kept as international", () => {
    expect(customerPhoneKey("+33612345678")).toBe("33612345678");
    expect(customerPhoneKey("0033 6 12 34 56 78")).toBe("33612345678");
  });
  it("missing or invalid → null (no matching)", () => {
    for (const raw of [null, undefined, "", "   ", "12345", "abc", "06123", "0812345678", "+2126123", "06 12 34 56 78 99"]) {
      expect(customerPhoneKey(raw), String(raw)).toBeNull();
    }
  });
});

describe("customerNameKey", () => {
  it("case, spaces, accents and invisible characters are ignored", () => {
    const key = customerNameKey("Youness Ayoub");
    for (const raw of ["youness ayoub", "  Youness   Ayoub ", "YOUNESS AYOUB", "Youness Ayoub", "Youness​ Ayoub"]) {
      expect(customerNameKey(raw), raw).toBe(key);
    }
    expect(customerNameKey("Hélène Dupont")).toBe(customerNameKey("Helene Dupont"));
  });
  it("no fuzzy matching: spelling variants stay different", () => {
    expect(customerNameKey("Mohamed Alami")).not.toBe(customerNameKey("Mohammed Alami"));
    expect(customerNameKey("Youness Ayoub")).not.toBe(customerNameKey("Ayoub Youness"));
  });
  it("empty and placeholder names have no key", () => {
    expect(customerNameKey("")).toBeNull();
    expect(customerNameKey("   ")).toBeNull();
    expect(customerNameKey("client@mail.com")).toBeNull();
    expect(customerNameKey("Client WooCommerce #12")).toBeNull();
    expect(customerNameKey("Client Shopify #1001")).toBeNull();
    expect(isPlaceholderCustomerName("Client WooCommerce #0")).toBe(true);
    expect(isPlaceholderCustomerName("Clientèle Ayoub")).toBe(false);
  });
});

describe("isSameCustomerIdentity — the business rule", () => {
  const a = { fullName: "Youness Ayoub", phone: "0612345678" };
  it("same normalized name + same normalized phone → same customer", () => {
    expect(isSameCustomerIdentity(a, { fullName: " youness  AYOUB ", phone: "+212 6 12 34 56 78" })).toBe(true);
  });
  it("same phone, different name → different customer", () => {
    expect(isSameCustomerIdentity(a, { fullName: "Karim Alami", phone: "0612345678" })).toBe(false);
  });
  it("same name, different phone → different customer", () => {
    expect(isSameCustomerIdentity(a, { fullName: "Youness Ayoub", phone: "0699999999" })).toBe(false);
  });
  it("missing / invalid phone or placeholder name → never the same", () => {
    expect(isSameCustomerIdentity({ fullName: "Youness Ayoub", phone: null }, { fullName: "Youness Ayoub", phone: null })).toBe(false);
    expect(isSameCustomerIdentity({ fullName: "Youness Ayoub", phone: "123" }, { fullName: "Youness Ayoub", phone: "123" })).toBe(false);
    expect(isSameCustomerIdentity({ fullName: "a@b.com", phone: "0612345678" }, { fullName: "a@b.com", phone: "0612345678" })).toBe(false);
  });
});

describe("maskCustomerPhone", () => {
  it("only the last 2 digits are shown", () => {
    expect(maskCustomerPhone("212612345678")).toBe("••••••78");
    expect(maskCustomerPhone(null)).toBe("—");
  });
});

describe("customerPhoneSearchKeys — search only, never identity", () => {
  const key = "212612345678";
  const finds = (q: string) => customerPhoneSearchKeys(q).some((k) => key.includes(k));
  it("partial digits (4–5) and the full number in any format find the stored phoneKey", () => {
    for (const q of ["1234", "34567", "0612", "06 12 34", "612 34", "0612345678", "+212 6 12 34 56 78", "00212612345678"]) {
      expect(finds(q), q).toBe(true);
    }
    expect(finds("9999")).toBe(false);
  });
  it("names, letters and fewer than 3 digits give no phone keys", () => {
    expect(customerPhoneSearchKeys("Sara")).toEqual([]);
    expect(customerPhoneSearchKeys("06")).toEqual([]);
    expect(customerPhoneSearchKeys("06ab")).toEqual([]);
  });
});
