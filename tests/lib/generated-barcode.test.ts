import { describe, expect, it } from "vitest";
import {
  formatGeneratedProductBarcode,
  GENERATED_BARCODE_MAX_SEQUENCE,
  isGeneratedProductBarcode,
} from "@/lib/catalog/generated-barcode";
import { gs1CheckDigitWarning, gtinEquivalents } from "@/lib/catalog/gs1";
import { labelBarcode } from "@/lib/catalog/label-barcode";
import { scanMissHint } from "@/lib/catalog/scan-input";

/** Generated product / variation barcodes — pure helpers (docs/adr/0061). */
describe("formatGeneratedProductBarcode", () => {
  it("is « 20 » + 10-digit sequence + a valid GS1 check digit (13 digits)", () => {
    expect(formatGeneratedProductBarcode(1)).toBe("2000000000015");
    expect(formatGeneratedProductBarcode(2)).toBe("2000000000022");
    expect(formatGeneratedProductBarcode(1234567890)).toMatch(/^201234567890\d$/);
    for (const n of [1, 7, 42, 999, 123456, 9_999_999_999]) {
      const code = formatGeneratedProductBarcode(n);
      expect(code).toHaveLength(13);
      expect(gs1CheckDigitWarning(code)).toBeNull(); // the app's own GS1 check stays silent
    }
  });

  it("keeps inner zeros (a string, never a number)", () => {
    const code = formatGeneratedProductBarcode(10);
    expect(code.slice(0, 12)).toBe("200000000010");
    expect(typeof code).toBe("string");
  });

  it("accepts a bigint sequence and refuses out-of-range ones", () => {
    expect(formatGeneratedProductBarcode(BigInt(3))).toBe(formatGeneratedProductBarcode(3));
    expect(formatGeneratedProductBarcode(GENERATED_BARCODE_MAX_SEQUENCE)).toMatch(/^209999999999\d$/);
    for (const bad of [0, -1, Number(GENERATED_BARCODE_MAX_SEQUENCE) + 1]) expect(() => formatGeneratedProductBarcode(bad)).toThrow(RangeError);
    expect(() => formatGeneratedProductBarcode(1.5)).toThrow();
  });
});

describe("isGeneratedProductBarcode", () => {
  it("recognises the generator's shape only", () => {
    expect(isGeneratedProductBarcode("2000000000015")).toBe(true);
    expect(isGeneratedProductBarcode(" 2000000000015 ")).toBe(true);
    expect(isGeneratedProductBarcode("2000000000016")).toBe(false); // wrong check digit
    expect(isGeneratedProductBarcode("6111000000014")).toBe(false); // a real EAN-13 (Morocco prefix)
    expect(isGeneratedProductBarcode("200000000001")).toBe(false); // 12 digits
    expect(isGeneratedProductBarcode("SKU-2000000000015")).toBe(false);
    expect(isGeneratedProductBarcode(null)).toBe(false);
  });

  it("can never be another spelling of a stored UPC / GTIN-14 (no leading zero)", () => {
    expect(gtinEquivalents("2000000000015")).toEqual(["02000000000015"]);
    // …and that GTIN-14 spelling (with a leading zero) is never generated itself.
    expect(isGeneratedProductBarcode("02000000000015")).toBe(false);
  });
});

describe("label and scanner compatibility", () => {
  it("the label prints a generated code as stored, captioned as internal (kind « generated »)", () => {
    expect(labelBarcode({ barcode: "2000000000015", sku: "TSB-1" })).toEqual({ kind: "generated", value: "2000000000015" });
    expect(labelBarcode({ barcode: "6111000000014", sku: "TSB-1" })).toEqual({ kind: "official", value: "6111000000014" });
  });

  it("an all-digit generated code keeps the existing AZERTY keyboard-layout hint", () => {
    // « 2000000000015 » typed by a QWERTY scanner on an AZERTY computer.
    expect(scanMissHint("éàààààààààà&(")?.kind).toBe("layout-azerty");
  });
});
