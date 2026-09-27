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

export type ScannerSupportStatus = "supported" | "unsupported-detector" | "unsupported-camera";

/** What the calling component actually detected in the browser — gathered
 * there (impure), decided here (pure). */
export interface ScannerEnvironment {
  hasBarcodeDetector: boolean;
  hasMediaDevices: boolean;
}

export function evaluateScannerSupport(env: ScannerEnvironment): ScannerSupportStatus {
  if (!env.hasMediaDevices) return "unsupported-camera";
  if (!env.hasBarcodeDetector) return "unsupported-detector";
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

export type ScannerErrorKind = "permission-denied" | "no-camera" | "camera-busy" | "unknown";

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
    case "unsupported-detector":
    case "unsupported-camera":
      return "Le scan par caméra n'est pas disponible sur cet appareil. Utilisez la saisie manuelle ou un scanner externe.";
    case "permission-denied":
      return "Accès à la caméra refusé. Autorisez la caméra dans les réglages du navigateur, ou utilisez la saisie manuelle.";
    case "no-camera":
      return "Aucune caméra détectée sur cet appareil. Utilisez la saisie manuelle ou un scanner externe.";
    case "camera-busy":
      return "La caméra est déjà utilisée par une autre application. Fermez-la puis réessayez, ou utilisez la saisie manuelle.";
    case "unknown":
      return "Impossible d'ouvrir la caméra. Utilisez la saisie manuelle ou un scanner externe.";
    case "supported":
      return "";
  }
}
