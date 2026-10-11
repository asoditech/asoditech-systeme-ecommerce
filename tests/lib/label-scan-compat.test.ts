import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import JsBarcode from "jsbarcode";
import QRCode from "qrcode";
import { ZXING_WASM_PATH } from "@/lib/barcode-scanner/decoder";
import { LOOKUP_SCAN_FORMATS, RELEVANT_BARCODE_FORMATS } from "@/lib/barcode-scanner/support";
import { CODE128_QUIET_ZONE_MODULES, QR_ERROR_CORRECTION, QR_QUIET_ZONE_MODULES, labelBarcodeFit, labelQrFit } from "@/lib/catalog/label-layout";
import { labelBarcode } from "@/lib/catalog/label-barcode";
import { gtinEquivalents } from "@/lib/catalog/gs1";
import { labelQrToken } from "@/lib/catalog/scan-input";

/**
 * The printed ASODITECH label (src/components/products/printable-label.tsx)
 * against the REAL camera decoder (the self-hosted ZXing WASM, through the
 * same ponyfill iPhone/Firefox use): the label's Code 128 bars and its QR are
 * rendered from the very same encoders (JsBarcode / qrcode) into images —
 * plain, stretched wide / tall, framed, with and without quiet zone — and
 * decoded. Synthetic images only: printing on a thermal printer, a phone
 * camera and the HENEX scanner still need a physical test.
 */

const root = path.resolve(import.meta.dirname, "../..");
const wasmFile = path.join(root, "public", ZXING_WASM_PATH);

type Img = { data: Uint8ClampedArray; width: number; height: number };
type Detector = { detect(source: unknown): Promise<{ rawValue: string; format: string }[]> };

function blank(width: number, height: number): Img {
  return { data: new Uint8ClampedArray(width * height * 4).fill(255), width, height };
}
function fillRect(img: Img, x0: number, y0: number, w: number, h: number) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) img.data.set([0, 0, 0, 255], (y * img.width + x) * 4);
}

/** The label's linear barcode: JsBarcode's own CODE128 modules, `quiet` blank modules each side (the label uses 10). */
function renderCode128(value: string, opts: { module?: number; height?: number; quiet?: number } = {}): Img {
  const out: { encodings?: { data: string }[] } = {};
  JsBarcode(out, value, { format: "CODE128" });
  const bits = (out.encodings ?? []).map((e) => e.data).join("");
  const m = opts.module ?? 2;
  const quiet = opts.quiet ?? CODE128_QUIET_ZONE_MODULES;
  const img = blank((bits.length + 2 * quiet) * m, opts.height ?? 60);
  [...bits].forEach((b, i) => b === "1" && fillRect(img, (quiet + i) * m, 0, m, img.height));
  return img;
}

/** The label's QR: qrcode's own module matrix, `margin` blank modules around it. */
function renderQr(text: string, opts: { module?: number; margin?: number } = {}): Img {
  const qr = QRCode.create(text, { errorCorrectionLevel: QR_ERROR_CORRECTION });
  const size = qr.modules.size;
  const m = opts.module ?? 4;
  const margin = opts.margin ?? QR_QUIET_ZONE_MODULES;
  const img = blank((size + 2 * margin) * m, (size + 2 * margin) * m);
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (qr.modules.get(r, c)) fillRect(img, (margin + c) * m, (margin + r) * m, m, m);
  return img;
}

/** `inner` pasted on a white canvas with `gap` px of white then a `stroke` px black frame. */
function framed(inner: Img, gap: number, stroke = 3): Img {
  const pad = gap + stroke;
  const img = blank(inner.width + 2 * pad, inner.height + 2 * pad);
  fillRect(img, 0, 0, img.width, stroke);
  fillRect(img, 0, img.height - stroke, img.width, stroke);
  fillRect(img, 0, 0, stroke, img.height);
  fillRect(img, img.width - stroke, 0, stroke, img.height);
  for (let y = 0; y < inner.height; y++) img.data.set(inner.data.subarray(y * inner.width * 4, (y + 1) * inner.width * 4), ((y + pad) * img.width + pad) * 4);
  return img;
}

/** Nearest-neighbour resize — a barcode image stretched to an unusual aspect ratio. */
function resize(src: Img, width: number, height: number): Img {
  const img = blank(width, height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const sx = Math.floor((x * src.width) / width);
      const sy = Math.floor((y * src.height) / height);
      img.data.set(src.data.subarray((sy * src.width + sx) * 4, (sy * src.width + sx) * 4 + 4), (y * width + x) * 4);
    }
  return img;
}

// EAN-13 (standard tables) — same renderer as tests/lib/barcode-decoder.test.ts.
const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const R = L.map((p) => [...p].map((b) => (b === "1" ? "0" : "1")).join(""));
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];
function renderEan13(code: string, m = 3, height = 60): Img {
  const d = [...code].map(Number);
  let bits = "101";
  for (let i = 0; i < 6; i++) bits += (PARITY[d[0]][i] === "L" ? L : G)[d[i + 1]];
  bits += "01010";
  for (let i = 7; i < 13; i++) bits += R[d[i]];
  bits += "101";
  bits = "0".repeat(11) + bits + "0".repeat(11);
  const img = blank(bits.length * m, height);
  [...bits].forEach((b, i) => b === "1" && fillRect(img, i * m, 0, m, height));
  return img;
}

let lib: { BarcodeDetector: new (o: { formats: string[] }) => Detector };
const toImageData = (img: Img) =>
  new (globalThis as unknown as { ImageData: new (d: Uint8ClampedArray, w: number, h: number) => unknown }).ImageData(img.data, img.width, img.height);
const decode = async (img: Img, formats: readonly string[] = LOOKUP_SCAN_FORMATS) =>
  (await new lib.BarcodeDetector({ formats: [...formats] }).detect(toImageData(img))).map((f) => [f.rawValue, f.format]);

beforeAll(async () => {
  if (!("ImageData" in globalThis)) {
    (globalThis as Record<string, unknown>).ImageData = class ImageData {
      colorSpace = "srgb";
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number
      ) {}
    };
  }
  if (!("DOMRectReadOnly" in globalThis)) {
    (globalThis as Record<string, unknown>).DOMRectReadOnly = class DOMRectReadOnly {
      constructor(
        public x = 0,
        public y = 0,
        public width = 0,
        public height = 0
      ) {}
    };
  }
  const mod = await import("barcode-detector/ponyfill");
  const bin = readFileSync(wasmFile);
  await mod.prepareZXingModule({
    overrides: { wasmBinary: bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer },
    fireImmediately: true,
  });
  lib = mod as unknown as typeof lib;
});

// A real label URL shape: https://<host>/scan/<43-char base64url token>.
const TOKEN = "Zm9vYmFyYmF6cXV4LWxhYmVsLXRva2VuLTEyMzQ1Njc";
const LABEL_URL = `https://www.asoditech.com/scan/${TOKEN}`;

describe("label Code 128 (SKU as internal code / official barcode) — real decode", () => {
  for (const value of ["TEST-RETOUR-1", "tshirt-noir-xl", "0001234", "AB 12/x"]) {
    it(`reads « ${value} » exactly, as printed (10-module quiet zones)`, async () => {
      expect(labelBarcode({ barcode: null, sku: value })).toEqual({ kind: "internal", value });
      expect(await decode(renderCode128(value))).toEqual([[value, "code_128"]]);
    });
  }

  it("keeps leading zeros (a code is text, never a number)", async () => {
    expect(await decode(renderCode128("000123"))).toEqual([["000123", "code_128"]]);
  });

  it("stretched wide (×3 width) and very tall (×6 height): still read", async () => {
    const base = renderCode128("SKU-LONG-0042", { module: 2, height: 50 });
    expect(await decode(resize(base, base.width * 3, base.height))).toEqual([["SKU-LONG-0042", "code_128"]]);
    expect(await decode(resize(base, base.width, base.height * 6))).toEqual([["SKU-LONG-0042", "code_128"]]);
  });

  it("a frame AROUND the quiet zone does not prevent reading", async () => {
    expect(await decode(framed(renderCode128("FRAME-OK-1"), 6))).toEqual([["FRAME-OK-1", "code_128"]]);
  });

  it("no quiet zone and a frame right against the bars: NOT read (why a clipped margin fails)", async () => {
    expect(await decode(framed(renderCode128("FRAME-KO-1", { quiet: 0 }), 0))).toEqual([]);
  });

  it("module width on the 47 mm bar area: EAN-13 and short SKUs are ≥ 0.25 mm, a 13+ character SKU is not (the label page warns)", () => {
    expect(labelBarcodeFit("6111234567895")).toMatchObject({ legible: true }); // ≈ 0.33 mm (Code 128 set C)
    expect(labelBarcodeFit("TS-NOIR-M")).toMatchObject({ legible: true }); // ≈ 0.30 mm
    expect(labelBarcodeFit("TEST-RETOUR-1")).toMatchObject({ legible: false }); // ≈ 0.24 mm
    expect(labelBarcodeFit("TSHIRT-NOIR-XL-01")).toMatchObject({ legible: false }); // ≈ 0.19 mm
  });
});

describe("label QR (public /scan/<token> URL) — real decode", () => {
  it("encodes the scan URL, NOT the SKU or the barcode", async () => {
    expect(await decode(renderQr(LABEL_URL), ["qr_code"])).toEqual([[LABEL_URL, "qr_code"]]);
    expect(labelQrToken(LABEL_URL)).toBe(TOKEN);
  });

  it("the linear-only formats (product barcode fields) ignore it: nothing is read", async () => {
    expect(await decode(renderQr(LABEL_URL), RELEVANT_BARCODE_FORMATS)).toEqual([]);
  });

  it("lookup screens' camera formats include QR: the label QR is read", async () => {
    expect(LOOKUP_SCAN_FORMATS).toContain("qr_code");
    expect(await decode(renderQr(LABEL_URL))).toEqual([[LABEL_URL, "qr_code"]]);
  });

  it("a framed QR with its 4-module quiet zone is read", async () => {
    expect(await decode(framed(renderQr(LABEL_URL), 4))).toEqual([[LABEL_URL, "qr_code"]]);
  });

  it("the QR fits its 12 mm square with its quiet zone at the production URL length", () => {
    const fit = labelQrFit(LABEL_URL)!;
    expect(fit.quietZoneOk).toBe(true);
    expect(fit.legible).toBe(true);
  });
});

describe("retail EAN-13 / UPC — real decode and lookup equivalence", () => {
  it("an EAN-13 with a leading 0 is reported in a form the lookup matches (12 or 13 digits)", async () => {
    const stored = "0012345678905";
    const found = await decode(renderEan13(stored));
    expect(found).toHaveLength(1);
    const read = found[0][0];
    expect([read, ...gtinEquivalents(read)]).toContain(stored);
  });

  it("a Moroccan EAN-13 (611…) is read exactly", async () => {
    expect(await decode(renderEan13("6111234567895"))).toEqual([["6111234567895", "ean_13"]]);
  });
});
