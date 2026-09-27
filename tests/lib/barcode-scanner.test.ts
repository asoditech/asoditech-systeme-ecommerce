import { describe, expect, it } from "vitest";
import { evaluateScannerSupport, classifyScannerError, scannerStatusMessage, RELEVANT_BARCODE_FORMATS } from "@/lib/barcode-scanner/support";

/**
 * Batch 5 — Barcode Camera Scanner. Pure decision logic only (no real
 * camera/DOM needed — this repo's Vitest runs in a plain Node
 * environment, no jsdom/browser globals, so the component itself isn't
 * rendered here; see barcode-scan-button.tsx for how these functions are
 * wired to the actual browser APIs).
 */
describe("evaluateScannerSupport", () => {
  it("supported: both BarcodeDetector and camera access exist", () => {
    expect(evaluateScannerSupport({ hasBarcodeDetector: true, hasMediaDevices: true })).toBe("supported");
  });

  it("unsupported-detector: camera exists but no BarcodeDetector (e.g. Firefox, Safari at time of writing)", () => {
    expect(evaluateScannerSupport({ hasBarcodeDetector: false, hasMediaDevices: true })).toBe("unsupported-detector");
  });

  it("unsupported-camera: no getUserMedia at all takes priority over the detector check", () => {
    expect(evaluateScannerSupport({ hasBarcodeDetector: true, hasMediaDevices: false })).toBe("unsupported-camera");
    expect(evaluateScannerSupport({ hasBarcodeDetector: false, hasMediaDevices: false })).toBe("unsupported-camera");
  });
});

describe("classifyScannerError", () => {
  it("maps NotAllowedError / SecurityError to permission-denied", () => {
    expect(classifyScannerError(Object.assign(new Error(), { name: "NotAllowedError" }))).toBe("permission-denied");
    expect(classifyScannerError(Object.assign(new Error(), { name: "SecurityError" }))).toBe("permission-denied");
  });

  it("maps NotFoundError / OverconstrainedError to no-camera", () => {
    expect(classifyScannerError(Object.assign(new Error(), { name: "NotFoundError" }))).toBe("no-camera");
    expect(classifyScannerError(Object.assign(new Error(), { name: "OverconstrainedError" }))).toBe("no-camera");
  });

  it("maps NotReadableError / TrackStartError (camera already in use) to camera-busy", () => {
    expect(classifyScannerError(Object.assign(new Error(), { name: "NotReadableError" }))).toBe("camera-busy");
  });

  it("falls back to unknown for anything else, including non-Error throws — never crashes", () => {
    expect(classifyScannerError(Object.assign(new Error(), { name: "AbortError" }))).toBe("unknown");
    expect(classifyScannerError("a plain string")).toBe("unknown");
    expect(classifyScannerError(null)).toBe("unknown");
    expect(classifyScannerError(undefined)).toBe("unknown");
  });
});

describe("scannerStatusMessage", () => {
  it("both unsupported states show the exact copy the spec requires", () => {
    const expected = "Le scan par caméra n'est pas disponible sur cet appareil. Utilisez la saisie manuelle ou un scanner externe.";
    expect(scannerStatusMessage("unsupported-detector")).toBe(expected);
    expect(scannerStatusMessage("unsupported-camera")).toBe(expected);
  });

  it("every error kind has a non-empty, distinct message", () => {
    const kinds = ["permission-denied", "no-camera", "camera-busy", "unknown"] as const;
    const messages = kinds.map((k) => scannerStatusMessage(k));
    expect(messages.every((m) => m.length > 0)).toBe(true);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it("'supported' has no message — that state never shows a fallback banner", () => {
    expect(scannerStatusMessage("supported")).toBe("");
  });
});

describe("RELEVANT_BARCODE_FORMATS", () => {
  it("is limited to linear/retail formats — no 2D formats the app has no use for", () => {
    expect(RELEVANT_BARCODE_FORMATS).toContain("ean_13");
    expect(RELEVANT_BARCODE_FORMATS).toContain("upc_a");
    expect(RELEVANT_BARCODE_FORMATS).not.toContain("qr_code");
    expect(RELEVANT_BARCODE_FORMATS).not.toContain("data_matrix");
    expect(RELEVANT_BARCODE_FORMATS).not.toContain("pdf417");
  });
});
