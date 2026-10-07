import {
  CAMERA_CONSTRAINTS,
  cameraFeaturesFrom,
  classifyScannerError,
  evaluateScannerSupport,
  type CameraCapabilitiesLike,
  type CameraFeatures,
  type ScannerEnvironment,
  type ScannerErrorKind,
  type ScannerSupportStatus,
} from "@/lib/barcode-scanner/support";

/**
 * One camera-scan session: support check → camera permission → stream →
 * detection loop → stop. Browser APIs are injected so the whole lifecycle
 * is unit-testable with fakes (tests/lib/barcode-scanner-session.test.ts);
 * src/components/barcode-scanner/barcode-scan-button.tsx wires the real
 * ones. Guarantees:
 *   - the camera is requested only when the environment supports scanning
 *     (and only once the caller starts a session — i.e. after a user click);
 *   - the <video> element is read on every tick, never captured once up
 *     front (it may not be mounted yet when the session starts);
 *   - never two `detect()` calls in flight at once;
 *   - "single" mode (default): at most ONE `onDetect`, then the camera is
 *     released; "continuous" mode: every new code is reported, the same code
 *     is ignored for `debounceMs`, and the camera stays open until `stop()`;
 *   - focus / zoom / torch are used ONLY when the camera itself reports them
 *     (`getCapabilities()`); a refusal is ignored, scanning goes on;
 *   - `stop()` is idempotent and always releases the camera — including a
 *     stream that only arrives after `stop()` was called.
 */

export type ScanPhase =
  | { kind: "checking" }
  | { kind: "unsupported"; reason: Exclude<ScannerSupportStatus, "supported"> }
  | { kind: "starting" }
  /** Camera ready, decoder (e.g. the WebAssembly one on iPhone) still loading. */
  | { kind: "loading" }
  | { kind: "scanning" }
  | { kind: "detected"; code: string }
  | { kind: "error"; errorKind: ScannerErrorKind };

export interface TrackLike {
  stop(): void;
  kind?: string;
  /** Not in every browser — and its content varies per device. */
  getCapabilities?(): CameraCapabilitiesLike;
  applyConstraints?(constraints: { advanced: Record<string, unknown>[] }): Promise<void>;
}

export interface StreamLike {
  getTracks(): TrackLike[];
}

export interface VideoLike {
  srcObject: unknown;
  readyState: number;
  play(): Promise<void> | void;
}

export interface DetectorLike {
  detect(source: VideoLike): Promise<{ rawValue: string }[]>;
}

export type ScanMode = "single" | "continuous";

export interface ScanSessionDeps {
  env: ScannerEnvironment;
  getUserMedia(constraints: typeof CAMERA_CONSTRAINTS): Promise<StreamLike>;
  /** May be async (the WebAssembly decoder is loaded lazily). Started in parallel
   * with the permission prompt — both only after the user opened the scanner. */
  createDetector(): DetectorLike | Promise<DetectorLike>;
  getVideo(): VideoLike | null;
  /** Repeating timer; returns its cancel function. */
  every(ms: number, tick: () => void): () => void;
  onPhase(phase: ScanPhase): void;
  /** Single mode: called at most once. Continuous: once per new code (debounced). Always a trimmed, non-empty code. */
  onDetect(code: string): void;
  /** Default "single" — every existing caller's behaviour. */
  mode?: ScanMode;
  /** Continuous mode: the same code is ignored for this long after it was accepted. */
  debounceMs?: number;
  /** What this camera supports (reported once the stream is open). */
  onFeatures?(features: CameraFeatures): void;
  /** Clock, injectable for tests. */
  now?(): number;
}

export type ScanNowResult = "detected" | "duplicate" | "none" | "busy" | "not-ready";

export interface ScanSession {
  stop(): void;
  /** Decode the current frame right now (« Scanner maintenant »), without waiting for the next tick. */
  scanNow(): Promise<ScanNowResult>;
  /** Only when the camera reported zoom; the value is clamped to its range. Resolves false when not applied. */
  setZoom(value: number): Promise<boolean>;
  /** Only when the camera reported a torch. Resolves false when not applied. */
  setTorch(on: boolean): Promise<boolean>;
}

export const DETECT_INTERVAL_MS = 300;
export const CONTINUOUS_DEBOUNCE_MS = 1500;
/** HTMLMediaElement.HAVE_CURRENT_DATA — a frame is available to decode. */
const HAVE_CURRENT_DATA = 2;

const NO_FEATURES: CameraFeatures = { continuousFocus: false, zoom: null, torch: false };

export function startScanSession(deps: ScanSessionDeps): ScanSession {
  const mode: ScanMode = deps.mode ?? "single";
  const debounceMs = deps.debounceMs ?? CONTINUOUS_DEBOUNCE_MS;
  const now = deps.now ?? (() => Date.now());

  let stopped = false;
  let detected = false; // single mode: the one code was reported
  let inFlight = false;
  let stream: StreamLike | null = null;
  let videoTrack: TrackLike | null = null;
  let features: CameraFeatures = NO_FEATURES;
  let detector: DetectorLike | null = null;
  let cancelTimer: (() => void) | null = null;
  let attachedTo: VideoLike | null = null;
  let lastCode: { code: string; at: number } | null = null;

  const releaseCamera = () => {
    if (cancelTimer) {
      cancelTimer();
      cancelTimer = null;
    }
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    videoTrack = null;
    if (attachedTo) {
      attachedTo.srcObject = null;
      attachedTo = null;
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    releaseCamera();
  };

  const attachIfNeeded = () => {
    const video = deps.getVideo();
    if (!video || !stream) return null;
    if (attachedTo !== video || video.srcObject !== stream) {
      video.srcObject = stream;
      attachedTo = video;
      try {
        void Promise.resolve(video.play()).catch(() => {
          // Autoplay of a muted, inline stream is allowed everywhere we
          // support; if a browser still refuses, the next tick retries.
        });
      } catch {
        // same as above
      }
    }
    return video;
  };

  const applyAdvanced = async (constraint: Record<string, unknown>): Promise<boolean> => {
    if (!videoTrack?.applyConstraints) return false;
    try {
      await videoTrack.applyConstraints({ advanced: [constraint] });
      return true;
    } catch {
      return false; // the device refused: keep scanning without it
    }
  };

  /** A decoded frame → accept, ignore (duplicate) or nothing. */
  const handleCodes = (codes: { rawValue: string }[]): "detected" | "duplicate" | "none" => {
    const code = codes.map((c) => c.rawValue?.trim() ?? "").find((c) => c.length > 0);
    if (!code) return "none";
    if (mode === "single") {
      detected = true;
      releaseCamera();
      deps.onPhase({ kind: "detected", code });
      deps.onDetect(code);
      return "detected";
    }
    const at = now();
    if (lastCode && lastCode.code === code && at - lastCode.at < debounceMs) return "duplicate";
    lastCode = { code, at };
    deps.onDetect(code);
    return "detected";
  };

  const decodeOnce = async (): Promise<ScanNowResult> => {
    if (stopped || detected || !detector) return "not-ready";
    if (inFlight) return "busy";
    const video = attachIfNeeded();
    if (!video || video.readyState < HAVE_CURRENT_DATA) return "not-ready";
    inFlight = true;
    try {
      const codes = await detector.detect(video);
      if (stopped || detected) return "not-ready";
      return handleCodes(codes);
    } catch {
      return "none"; // one frame failed to decode — not fatal
    } finally {
      inFlight = false;
    }
  };

  void (async () => {
    const support = evaluateScannerSupport(deps.env);
    if (support !== "supported") {
      deps.onPhase({ kind: "unsupported", reason: support });
      return;
    }

    deps.onPhase({ kind: "starting" });
    // Decoder load runs alongside the permission prompt; its outcome is read
    // after the camera opens (a rejection is captured here, never unhandled).
    let detectorReady = false;
    const detectorPromise: Promise<{ ok: true; detector: DetectorLike } | { ok: false }> = Promise.resolve()
      .then(() => deps.createDetector())
      .then(
        (d) => {
          detectorReady = true;
          return { ok: true as const, detector: d };
        },
        () => {
          detectorReady = true;
          return { ok: false as const };
        }
      );

    let s: StreamLike;
    try {
      s = await deps.getUserMedia(CAMERA_CONSTRAINTS);
    } catch (error) {
      if (!stopped) deps.onPhase({ kind: "error", errorKind: classifyScannerError(error) });
      return;
    }
    if (stopped) {
      // Closed while the permission prompt was open: release immediately.
      s.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = s;
    videoTrack = s.getTracks().find((t) => !t.kind || t.kind === "video") ?? null;

    // What this camera reports — never assumed. Continuous focus is switched
    // on when offered; zoom and torch are only exposed to the caller.
    let caps: CameraCapabilitiesLike | null = null;
    try {
      caps = videoTrack?.getCapabilities ? videoTrack.getCapabilities() : null;
    } catch {
      caps = null;
    }
    features = cameraFeaturesFrom(caps);
    if (features.continuousFocus) await applyAdvanced({ focusMode: "continuous" });
    if (stopped) return;
    deps.onFeatures?.(features);

    attachIfNeeded();
    if (!detectorReady) deps.onPhase({ kind: "loading" });
    const loaded = await detectorPromise;
    if (stopped) return; // stop() already released the camera
    if (!loaded.ok) {
      releaseCamera();
      deps.onPhase({ kind: "error", errorKind: "decoder-unavailable" });
      return;
    }
    detector = loaded.detector;

    deps.onPhase({ kind: "scanning" });
    cancelTimer = deps.every(DETECT_INTERVAL_MS, () => {
      if (stopped || detected || inFlight) return;
      void decodeOnce();
    });
  })();

  return {
    stop,
    scanNow: decodeOnce,
    setZoom: async (value: number) => {
      if (stopped || !features.zoom) return false;
      const { min, max } = features.zoom;
      return applyAdvanced({ zoom: Math.min(max, Math.max(min, value)) });
    },
    setTorch: async (on: boolean) => {
      if (stopped || !features.torch) return false;
      return applyAdvanced({ torch: on });
    },
  };
}
