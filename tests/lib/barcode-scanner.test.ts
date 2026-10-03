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

  it("no native BarcodeDetector but WebAssembly (iPhone/iPad, Firefox): supported via the bundled decoder", () => {
    expect(evaluateScannerSupport({ isSecureContext: true, hasBarcodeDetector: false, hasMediaDevices: true, hasWebAssembly: true })).toBe("supported");
    expect(evaluateScannerSupport({ isSecureContext: true, hasBarcodeDetector: false, hasMediaDevices: true, hasWebAssembly: false })).toBe("unsupported-detector");
  });

  it("decoder-unavailable has its own message with the manual fallback", () => {
    expect(scannerStatusMessage("decoder-unavailable")).toMatch(/n'a pas pu être chargé/);
    expect(scannerStatusMessage("decoder-unavailable")).toMatch(/saisie manuelle/);
  });

  it("insecure-context (plain http, e.g. a LAN address from a phone) is reported before anything else", () => {
    expect(evaluateScannerSupport({ isSecureContext: false, hasBarcodeDetector: false, hasMediaDevices: false })).toBe("insecure-context");
    expect(evaluateScannerSupport({ isSecureContext: false, hasBarcodeDetector: true, hasMediaDevices: true })).toBe("insecure-context");
    expect(evaluateScannerSupport({ isSecureContext: true, hasBarcodeDetector: true, hasMediaDevices: true })).toBe("supported");
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
  it("each unsupported cause has its own actionable message, always offering the manual fallback", () => {
    const insecure = scannerStatusMessage("insecure-context");
    const detector = scannerStatusMessage("unsupported-detector");
    const camera = scannerStatusMessage("unsupported-camera");
    expect(new Set([insecure, detector, camera]).size).toBe(3);
    expect(insecure).toMatch(/https/);
    expect(detector).toMatch(/trop ancien/);
    for (const m of [insecure, detector, camera]) expect(m).toMatch(/saisie manuelle/);
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
