import { describe, expect, it } from "vitest";
import {
  formatCustomerBarcode,
  looksLikeCustomerCode,
  normalizeScannedCustomerCode,
  parseCustomerBarcodeSequence,
} from "@/lib/customers/barcode";

/** Customer code « CL-000001 » — pure helpers (docs/adr/0060). */
describe("formatCustomerBarcode", () => {
  it("pads to 6 digits with the « CL- » prefix", () => {
    expect(formatCustomerBarcode(1)).toBe("CL-000001");
    expect(formatCustomerBarcode(42)).toBe("CL-000042");
    expect(formatCustomerBarcode(999999)).toBe("CL-999999");
  });

  it("grows naturally past six digits", () => {
    expect(formatCustomerBarcode(1000000)).toBe("CL-1000000");
    expect(formatCustomerBarcode(12345678)).toBe("CL-12345678");
  });

  it("refuses a non-positive or non-integer sequence", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => formatCustomerBarcode(bad)).toThrow(RangeError);
  });

  it("round-trips through parseCustomerBarcodeSequence", () => {
    for (const n of [1, 7, 999999, 1000000]) expect(parseCustomerBarcodeSequence(formatCustomerBarcode(n))).toBe(n);
    expect(parseCustomerBarcodeSequence("CL-")).toBeNull();
    expect(parseCustomerBarcodeSequence("SKU-000001")).toBeNull();
    expect(parseCustomerBarcodeSequence(null)).toBeNull();
  });
});

describe("normalizeScannedCustomerCode — keyboard scanners", () => {
  it("uppercases and trims a well-formed code", () => {
    expect(normalizeScannedCustomerCode("  cl-000123 ")).toEqual({ code: "CL-000123", layoutMismatch: false });
  });

  it("corrects a QWERTY scanner on an AZERTY computer (« CL)ààààà& »)", () => {
    expect(normalizeScannedCustomerCode("CL)ààààà&")).toEqual({ code: "CL-000001", layoutMismatch: true });
    expect(normalizeScannedCustomerCode("CL)àààà'(")).toEqual({ code: "CL-000045", layoutMismatch: true });
  });

  it("corrects an AZERTY scanner on a QWERTY computer (« CL6)))))! »)", () => {
    expect(normalizeScannedCustomerCode("CL6)))))!")).toEqual({ code: "CL-000001", layoutMismatch: true });
  });

  it("never invents a code from anything else", () => {
    expect(normalizeScannedCustomerCode("Amine Tazi")).toEqual({ code: "AMINE TAZI", layoutMismatch: false });
    expect(normalizeScannedCustomerCode("CLX")).toEqual({ code: "CLX", layoutMismatch: false });
    expect(normalizeScannedCustomerCode("")).toEqual({ code: "", layoutMismatch: false });
  });

  it("looksLikeCustomerCode routes « CL… » inputs only", () => {
    expect(looksLikeCustomerCode("CL-000001")).toBe(true);
    expect(looksLikeCustomerCode("cl)ààààà&")).toBe(true);
    expect(looksLikeCustomerCode("0612345678")).toBe(false);
  });
});
