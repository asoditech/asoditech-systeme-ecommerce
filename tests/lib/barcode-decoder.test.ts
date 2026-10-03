import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createBarcodeDecoder, ZXING_WASM_PATH, ZXING_WASM_VERSION_PINNED, type NativeDetectorCtor } from "@/lib/barcode-scanner/decoder";

/**
 * src/lib/barcode-scanner/decoder.ts — the decoder behind camera scanning:
 * native BarcodeDetector when usable, else the self-hosted ZXing WebAssembly
 * decoder (iPhone/iPad, Firefox). Includes a REAL decode of a generated
 * EAN-13 image by the actual self-hosted WASM, through the same ponyfill the
 * browser uses. No camera or iPhone involved: that still needs a real device.
 */

const root = path.resolve(import.meta.dirname, "../..");
const wasmFile = path.join(root, "public", ZXING_WASM_PATH);

// ---- EAN-13 rendering (standard encoding tables) into an RGBA buffer -------
const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const R = L.map((p) => [...p].map((b) => (b === "1" ? "0" : "1")).join(""));
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

function ean13WithCheckDigit(twelve: string) {
  const sum = [...twelve].reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return twelve + ((10 - (sum % 10)) % 10);
}

function renderEan13(code: string, moduleWidth = 3, height = 60) {
  const d = [...code].map(Number);
  let bits = "101";
  for (let i = 0; i < 6; i++) bits += (PARITY[d[0]][i] === "L" ? L : G)[d[i + 1]];
  bits += "01010";
  for (let i = 7; i < 13; i++) bits += R[d[i]];
  bits += "101";
  bits = "0".repeat(11) + bits + "0".repeat(11); // quiet zones
  const width = bits.length * moduleWidth;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let x = 0; x < width; x++) {
    if (bits[Math.floor(x / moduleWidth)] !== "1") continue;
    for (let y = 0; y < height; y++) data.set([0, 0, 0, 255], (y * width + x) * 4);
  }
  return { data, width, height };
}

describe("self-hosted WASM", () => {
  it("is exactly the reader WASM of the installed library version (upgrade guard)", async () => {
    const lib = await import("barcode-detector/ponyfill");
    expect(lib.ZXING_WASM_VERSION).toBe(ZXING_WASM_VERSION_PINNED);
    const sha = createHash("sha256").update(readFileSync(wasmFile)).digest("hex");
    expect(sha).toBe(lib.ZXING_WASM_SHA256);
  });
});

describe("real decode with the self-hosted WASM (same ponyfill as iPhone/Firefox)", () => {
  type Detector = { detect(source: unknown): Promise<{ rawValue: string; format: string }[]> };
  let detector: Detector;

  beforeAll(async () => {
    // Node has no ImageData; a browser does. Minimal stand-in for the test only.
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
    const lib = await import("barcode-detector/ponyfill");
    const bin = readFileSync(wasmFile);
    await lib.prepareZXingModule({
      overrides: { wasmBinary: bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer },
      fireImmediately: true,
    });
    detector = new lib.BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "codabar"] }) as unknown as Detector;
  });

  const image = (code: string) => {
    const { data, width, height } = renderEan13(code);
    return new (globalThis as unknown as { ImageData: new (d: Uint8ClampedArray, w: number, h: number) => unknown }).ImageData(data, width, height);
  };

  it("reads a retail EAN-13 exactly", async () => {
    const code = ean13WithCheckDigit("611100000001");
    const found = await detector.detect(image(code));
    expect(found.map((f) => [f.rawValue, f.format])).toEqual([[code, "ean_13"]]);
  });

  it("returns nothing (never throws) for an image without a barcode", async () => {
    const blank = new (globalThis as unknown as { ImageData: new (d: Uint8ClampedArray, w: number, h: number) => unknown }).ImageData(
      new Uint8ClampedArray(200 * 60 * 4).fill(255),
      200,
      60
    );
    await expect(detector.detect(blank)).resolves.toEqual([]);
  });
});

describe("createBarcodeDecoder — native vs WebAssembly", () => {
  const FORMATS = ["ean_13", "code_128"] as const;

  function nativeCtor(opts: { supported?: string[] | "throws"; ctorThrows?: boolean } = {}) {
    const created: { formats?: string[] }[] = [];
    const Ctor = function (this: unknown, options?: { formats?: string[] }) {
      if (opts.ctorThrows) throw new TypeError("unsupported");
      created.push(options ?? {});
      return { detect: async () => [] };
    } as unknown as NativeDetectorCtor;
    if (opts.supported !== undefined) {
      Ctor.getSupportedFormats = async () => {
        if (opts.supported === "throws") throw new Error("no");
        return opts.supported as string[];
      };
    }
    return { Ctor, created };
  }

  function wasmLoader() {
    const calls: string[][] = [];
    return { calls, load: async (formats: string[]) => (calls.push(formats), { detect: async () => [] }) };
  }

  it("uses the native detector when it supports our formats (only those formats requested)", async () => {
    const n = nativeCtor({ supported: ["ean_13", "qr_code"] });
    const w = wasmLoader();
    const r = await createBarcodeDecoder(FORMATS, { nativeCtor: n.Ctor, loadWasmDetector: w.load });
    expect(r.kind).toBe("native");
    expect(n.created).toEqual([{ formats: ["ean_13"] }]);
    expect(w.calls).toEqual([]); // WASM never loaded
  });

  it("no native detector (iPhone/iPad, Firefox): loads the WebAssembly one", async () => {
    const w = wasmLoader();
    const r = await createBarcodeDecoder(FORMATS, { nativeCtor: undefined, loadWasmDetector: w.load });
    expect(r.kind).toBe("wasm");
    expect(w.calls).toEqual([["ean_13", "code_128"]]);
  });

  it("native API present but none of our formats supported: WebAssembly", async () => {
    const w = wasmLoader();
    const r = await createBarcodeDecoder(FORMATS, { nativeCtor: nativeCtor({ supported: [] }).Ctor, loadWasmDetector: w.load });
    expect(r.kind).toBe("wasm");
  });

  it("native constructor rejecting the formats: WebAssembly", async () => {
    const w = wasmLoader();
    const r = await createBarcodeDecoder(FORMATS, { nativeCtor: nativeCtor({ supported: ["ean_13"], ctorThrows: true }).Ctor, loadWasmDetector: w.load });
    expect(r.kind).toBe("wasm");
  });

  it("getSupportedFormats failing: still tries native with all formats", async () => {
    const n = nativeCtor({ supported: "throws" });
    const r = await createBarcodeDecoder(FORMATS, { nativeCtor: n.Ctor, loadWasmDetector: wasmLoader().load });
    expect(r.kind).toBe("native");
    expect(n.created).toEqual([{ formats: ["ean_13", "code_128"] }]);
  });

  it("a WASM load failure is surfaced to the caller (the session shows « décodeur indisponible »)", async () => {
    await expect(
      createBarcodeDecoder(FORMATS, { nativeCtor: undefined, loadWasmDetector: async () => Promise.reject(new Error("network")) })
    ).rejects.toThrow("network");
  });
});

describe("lazy loading", () => {
  it("no module statically imports the library at runtime (only `import type`) — it loads when a scanner opens", () => {
    for (const rel of ["src/lib/barcode-scanner/decoder.ts", "src/components/barcode-scanner/barcode-scan-button.tsx", "src/lib/barcode-scanner/session.ts"]) {
      const src = readFileSync(path.join(root, rel), "utf8");
      const staticImports = src.split("\n").filter((l) => /^\s*import\s+(?!type\b)[^;]*from\s+["']barcode-detector/.test(l));
      expect(staticImports, rel).toEqual([]);
    }
    expect(readFileSync(path.join(root, "src/lib/barcode-scanner/decoder.ts"), "utf8")).toContain('await import("barcode-detector/ponyfill")');
  });
});
