import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import JsBarcode from "jsbarcode";
import { INTERNAL_CODE_CAPTION, INTERNAL_CODE_MAX_LENGTH, labelBarcode } from "@/lib/catalog/label-barcode";
import { gs1CheckDigit, gs1CheckDigitWarning } from "@/lib/catalog/gs1";
import { ZXING_WASM_PATH } from "@/lib/barcode-scanner/decoder";

/**
 * Internal-code labels (src/lib/catalog/label-barcode.ts) and the
 * non-blocking GS1 check-digit hint (src/lib/catalog/gs1.ts). Includes a
 * round trip: the label's Code 128 for a SKU, drawn from JsBarcode's own
 * encoding, is read back by the app's real ZXing WebAssembly decoder.
 */

describe("labelBarcode — what the label encodes", () => {
  it("an official (supplier/customer-entered) barcode is used as-is", () => {
    expect(labelBarcode({ barcode: " 6111000000014 ", sku: "TSB-NOIR-M" })).toEqual({ kind: "official", value: "6111000000014" });
  });

  it("no barcode → the existing SKU becomes an INTERNAL code", () => {
    expect(labelBarcode({ barcode: null, sku: "TSB-NOIR-M" })).toEqual({ kind: "internal", value: "TSB-NOIR-M" });
    expect(labelBarcode({ barcode: "  ", sku: " TSB-NOIR-M " })).toEqual({ kind: "internal", value: "TSB-NOIR-M" });
  });

  it("a SKU Code 128 cannot carry as printable text (non-ASCII, too long, empty) → no linear barcode", () => {
    expect(labelBarcode({ barcode: null, sku: "JABADOR-ÉTÉ" })).toEqual({ kind: "none" });
    expect(labelBarcode({ barcode: null, sku: "X".repeat(INTERNAL_CODE_MAX_LENGTH + 1) })).toEqual({ kind: "none" });
    expect(labelBarcode({ barcode: null, sku: "" })).toEqual({ kind: "none" });
  });

  it("the caption says it is internal and not an EAN/GTIN", () => {
    expect(INTERNAL_CODE_CAPTION).toMatch(/INTERNE/);
    expect(INTERNAL_CODE_CAPTION).toMatch(/PAS UN EAN\/GTIN/);
  });
});

describe("Code 128 internal label — generated and readable by the app's scanner decoder", () => {
  type Detector = { detect(source: unknown): Promise<{ rawValue: string; format: string }[]> };
  let detector: Detector;

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    g.ImageData ??= class ImageData {
      colorSpace = "srgb";
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number
      ) {}
    };
    g.DOMRectReadOnly ??= class DOMRectReadOnly {
      constructor(
        public x = 0,
        public y = 0,
        public width = 0,
        public height = 0
      ) {}
    };
    const lib = await import("barcode-detector/ponyfill");
    const bin = readFileSync(path.join(import.meta.dirname, "../../public", ZXING_WASM_PATH));
    await lib.prepareZXingModule({
      overrides: { wasmBinary: bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer },
      fireImmediately: true,
    });
    detector = new lib.BarcodeDetector({ formats: ["code_128", "ean_13"] }) as unknown as Detector;
  });

  /** JsBarcode (the label's own library) → bars → RGBA image, 2 px per module with quiet zones. */
  function code128Image(value: string) {
    const out: { encodings?: { data: string }[] } = {};
    JsBarcode(out, value, { format: "CODE128" });
    const bits = "0".repeat(12) + (out.encodings ?? []).map((e) => e.data).join("") + "0".repeat(12);
    const scale = 2;
    const width = bits.length * scale;
    const height = 50;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let x = 0; x < width; x++) {
      if (bits[Math.floor(x / scale)] !== "1") continue;
      for (let y = 0; y < height; y++) data.set([0, 0, 0, 255], (y * width + x) * 4);
    }
    const Img = (globalThis as unknown as { ImageData: new (d: Uint8ClampedArray, w: number, h: number) => unknown }).ImageData;
    return new Img(data, width, height);
  }

  it.each(["TSB-NOIR-M", "T-SHIRT-BASIC-BLANC-XL", "POLO-1"])("encodes %s as Code 128 and decodes back to the exact SKU", async (sku) => {
    const label = labelBarcode({ barcode: null, sku });
    expect(label.kind).toBe("internal");
    const found = await detector.detect(code128Image(label.kind === "internal" ? label.value : ""));
    expect(found.map((f) => [f.rawValue, f.format])).toEqual([[sku, "code_128"]]);
  });
});

describe("gs1CheckDigitWarning — non-blocking, numeric GTIN lengths only", () => {
  it("valid GS1 codes of every checked length give no warning", () => {
    for (const code of ["96385074", "036000291452", "4006381333931", "00012345678905"]) {
      expect(gs1CheckDigitWarning(code), code).toBeNull();
    }
  });

  it("a wrong check digit gives a warning naming the expected digit", () => {
    const warning = gs1CheckDigitWarning("4006381333932");
    expect(warning).toMatch(/chiffre de contrôle/);
    expect(warning).toMatch(/attendu : 1/);
    expect(warning).toMatch(/vous pouvez quand même l'enregistrer/);
    expect(gs1CheckDigitWarning("96385075")).not.toBeNull();
  });

  it("numeric codes of other lengths are not assumed to be GTINs", () => {
    for (const code of ["1", "1234567", "123456789", "1234567890", "12345678901", "123456789012345"]) {
      expect(gs1CheckDigitWarning(code), code).toBeNull();
    }
  });

  it("non-numeric codes are never checked", () => {
    for (const code of ["TSB-NOIR-M", "ABC12345", "4006381333931A", "4006 381 333 931", "", "   "]) {
      expect(gs1CheckDigitWarning(code), code).toBeNull();
    }
    expect(gs1CheckDigitWarning(null)).toBeNull();
  });

  it("trims surrounding spaces only, and computes the mod-10 digit", () => {
    expect(gs1CheckDigitWarning("  4006381333931 ")).toBeNull();
    expect(gs1CheckDigit("400638133393")).toBe(1);
    expect(gs1CheckDigit("03600029145")).toBe(2); // UPC-A 036000291452
  });
});
