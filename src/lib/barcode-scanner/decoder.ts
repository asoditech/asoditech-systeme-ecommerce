import type { BarcodeFormat } from "barcode-detector/ponyfill";
import type { DetectorLike } from "@/lib/barcode-scanner/session";

/**
 * Which barcode decoder a camera scan uses:
 *   1. the browser's native `BarcodeDetector` when it exists AND supports at
 *      least one of the requested formats (Chrome/Edge on Android, macOS);
 *   2. otherwise the bundled ZXing-C++ WebAssembly decoder, through the
 *      `barcode-detector` ponyfill — the same `BarcodeDetector` API, so the
 *      scan session does not change. This is what makes Safari on
 *      iPhone/iPad (all iOS browsers are WebKit), Firefox, and Chrome on
 *      Windows/Linux scan.
 *
 * The ponyfill (JS chunk + ~1.1 MB WASM) is loaded lazily, only when a
 * scanner is opened, and the WASM is SELF-HOSTED (public/vendor/…): no
 * request to a third-party CDN. tests/lib/barcode-decoder.test.ts checks
 * the self-hosted file's SHA-256 against the installed library, so an
 * upgrade that forgets to refresh it fails the suite.
 */

/** Must match the installed zxing-wasm version (ZXING_WASM_VERSION) — see the test above. */
export const ZXING_WASM_VERSION_PINNED = "3.1.3";
export const ZXING_WASM_PATH = `/vendor/zxing-wasm-${ZXING_WASM_VERSION_PINNED}/zxing_reader.wasm`;

export type DecoderKind = "native" | "wasm";

interface DetectorInstance {
  detect(source: never): Promise<{ rawValue: string }[]>;
}

export interface NativeDetectorCtor {
  new (options?: { formats?: string[] }): DetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
}

export interface DecoderDeps {
  /** `window.BarcodeDetector`, when the browser has one. */
  nativeCtor: NativeDetectorCtor | undefined;
  /** Loads the WebAssembly decoder for these formats (lazy import in the browser). */
  loadWasmDetector(formats: string[]): Promise<DetectorInstance>;
}

const wrap = (d: DetectorInstance): DetectorLike => ({ detect: (source) => d.detect(source as never) });

export async function createBarcodeDecoder(
  formats: readonly string[],
  deps: DecoderDeps
): Promise<{ kind: DecoderKind; detector: DetectorLike }> {
  if (deps.nativeCtor) {
    let supported: string[] | null = null;
    try {
      supported = deps.nativeCtor.getSupportedFormats ? await deps.nativeCtor.getSupportedFormats() : null;
    } catch {
      supported = null;
    }
    // A platform may expose the API but support no (or none of our) formats —
    // that native detector would never find anything: use the WASM one.
    const usable = supported ? formats.filter((f) => supported.includes(f)) : [...formats];
    if (usable.length > 0) {
      try {
        return { kind: "native", detector: wrap(new deps.nativeCtor({ formats: usable })) };
      } catch {
        // fall through to the WASM decoder
      }
    }
  }
  return { kind: "wasm", detector: wrap(await deps.loadWasmDetector([...formats])) };
}

/** Browser loader for the WASM decoder: lazy chunk + self-hosted WASM, fully loaded before resolving. */
export async function loadZXingDetector(formats: string[]): Promise<DetectorInstance> {
  const mod = await import("barcode-detector/ponyfill");
  await mod.prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? ZXING_WASM_PATH : prefix + path),
    },
    fireImmediately: true,
  });
  // Our format names are the standard BarcodeDetector ones (RELEVANT_BARCODE_FORMATS).
  return new mod.BarcodeDetector({ formats: formats as BarcodeFormat[] });
}
