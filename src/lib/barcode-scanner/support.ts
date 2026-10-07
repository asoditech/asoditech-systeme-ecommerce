/**
 * Camera barcode scanning — Batch 5. Pure decision logic, kept separate
 * from the browser-only APIs (`window.BarcodeDetector`, `getUserMedia`)
 * that supply its input, mirroring the pure/impure split already used for
 * `cityGuidanceFromProviders`, `generateAttributeCombinations`, etc. — so
 * it's fully unit-testable without a real camera/browser.
 *
 * Native BarcodeDetector only (docs/CONTRIBUTING.md — Batch 5 dependency
 * rule): no third-party scanning library. Where it's unavailable, manual
 * barcode entry (the existing input) remains the only path — this module
 * never blocks that.
 */

export type ScannerSupportStatus = "supported" | "insecure-context" | "unsupported-detector" | "unsupported-camera";

/** What the calling component actually detected in the browser — gathered
 * there (impure), decided here (pure). */
export interface ScannerEnvironment {
  /** Native `window.BarcodeDetector` (Chrome/Edge on Android and macOS). */
  hasBarcodeDetector: boolean;
  /** WebAssembly available: the bundled ZXing decoder (src/lib/barcode-scanner/decoder.ts)
   * replaces a missing native detector — this is what makes iPhone/iPad and Firefox work.
   * Optional so callers that predate it keep their behaviour. */
  hasWebAssembly?: boolean;
  hasMediaDevices: boolean;
  /** `window.isSecureContext`. Browsers only expose the camera on https
   * (or localhost): opened over plain http — e.g. http://192.168.x.x:3000
   * from a phone on the LAN — `navigator.mediaDevices` is simply absent.
   * Optional so callers that predate it keep their behaviour. */
  isSecureContext?: boolean;
}

export function evaluateScannerSupport(env: ScannerEnvironment): ScannerSupportStatus {
  // Checked first: it is the actual reason mediaDevices is missing, and the
  // only one the operator can fix (open the https address).
  if (env.isSecureContext === false) return "insecure-context";
  if (!env.hasMediaDevices) return "unsupported-camera";
  if (!env.hasBarcodeDetector && !env.hasWebAssembly) return "unsupported-detector";
  return "supported";
}

/**
 * Linear, retail-relevant symbologies only (docs/CONTRIBUTING.md — Batch 5
 * §3: "do not invent barcode formats the application cannot use"). The
 * app's own `Barcode.code` is an opaque alphanumeric string of whatever a
 * physical label actually encodes — in practice EAN-13/UPC for retail
 * goods, occasionally Code128/Code39/ITF/Codabar. No 2D formats (QR,
 * PDF417, Data Matrix, Aztec): those aren't what a garment/product label
 * uses here, and requesting them would just slow detection down.
 */
export const RELEVANT_BARCODE_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "codabar"] as const;

/**
 * Camera request: the rear camera, and a HIGHER resolution as an ideal (never
 * required — a camera that can't do it simply delivers less). With the default
 * (often 640×480) a barcode is only a few pixels wide, so people bring the
 * phone too close, below the lens's minimum focus distance → blur. More pixels
 * let the code be read from a little farther away, where the lens can focus.
 */
export const CAMERA_CONSTRAINTS = {
  audio: false,
  video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
} as const;

/** What `MediaStreamTrack.getCapabilities()` may report — every field optional, varies per browser AND device. */
export interface CameraCapabilitiesLike {
  focusMode?: string[];
  zoom?: { min?: number; max?: number; step?: number };
  torch?: boolean;
}

/**
 * What the scanner may use on THIS camera — only what the device itself
 * reports (Chrome on Android usually reports focus/zoom/torch on capable
 * phones; Safari on iPhone may report none of them). Nothing is assumed:
 * absent → not offered, and scanning works exactly as before.
 */
export interface CameraFeatures {
  continuousFocus: boolean;
  zoom: { min: number; max: number; step: number } | null;
  torch: boolean;
}

export function cameraFeaturesFrom(caps: CameraCapabilitiesLike | null | undefined): CameraFeatures {
  const z = caps?.zoom;
  const zoom =
    z && typeof z.min === "number" && typeof z.max === "number" && z.max > z.min
      ? { min: z.min, max: z.max, step: typeof z.step === "number" && z.step > 0 ? z.step : 0.1 }
      : null;
  return {
    continuousFocus: Array.isArray(caps?.focusMode) && caps.focusMode.includes("continuous"),
    zoom,
    torch: caps?.torch === true,
  };
}

/** `decoder-unavailable`: the barcode decoder could not be loaded (e.g. the WebAssembly file failed to download). */
export type ScannerErrorKind = "permission-denied" | "no-camera" | "camera-busy" | "decoder-unavailable" | "unknown";

/**
 * Maps a `getUserMedia`/detection-loop failure to one of the handled error
 * states (docs/CONTRIBUTING.md — Batch 5 §4: every one of these must be
 * handled, never an uncaught exception). Keyed on the standard
 * `MediaStreamError`/`DOMException` `.name` values every browser uses.
 */
export function classifyScannerError(error: unknown): ScannerErrorKind {
  const name = error instanceof Error ? error.name : typeof error === "object" && error && "name" in error ? String((error as { name: unknown }).name) : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "permission-denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "no-camera";
    case "NotReadableError":
    case "TrackStartError":
      return "camera-busy";
    default:
      return "unknown";
  }
}

/** The one, shared French copy for every scanner state — never duplicated
 * inline in the component. */
export function scannerStatusMessage(status: ScannerSupportStatus | ScannerErrorKind): string {
  switch (status) {
    case "insecure-context":
      return "Le scan par caméra exige une connexion sécurisée (adresse en https). Ouvrez l'application via son adresse https, ou utilisez la saisie manuelle ou un scanner externe.";
    case "unsupported-detector":
      // Neither a native BarcodeDetector nor WebAssembly (for the bundled
      // ZXing decoder): only very old browsers.
      return "Ce navigateur est trop ancien pour lire les codes-barres avec la caméra. Mettez-le à jour, ou utilisez la saisie manuelle ou un scanner externe.";
    case "unsupported-camera":
      return "Ce navigateur ne donne pas accès à la caméra. Utilisez la saisie manuelle ou un scanner externe.";
    case "permission-denied":
      return "Accès à la caméra refusé. Autorisez la caméra dans les réglages du navigateur, ou utilisez la saisie manuelle.";
    case "no-camera":
      return "Aucune caméra détectée sur cet appareil. Utilisez la saisie manuelle ou un scanner externe.";
    case "camera-busy":
      return "La caméra est déjà utilisée par une autre application. Fermez-la puis réessayez, ou utilisez la saisie manuelle.";
    case "decoder-unavailable":
      return "Le lecteur de codes-barres n'a pas pu être chargé (connexion interrompue ?). Fermez puis rouvrez le scanner, ou utilisez la saisie manuelle ou un scanner externe.";
    case "unknown":
      return "Impossible d'ouvrir la caméra. Utilisez la saisie manuelle ou un scanner externe.";
    case "supported":
      return "";
  }
}
