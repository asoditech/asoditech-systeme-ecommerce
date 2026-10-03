import {
  classifyScannerError,
  evaluateScannerSupport,
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
 *   - at most ONE `onDetect` per session, and never two `detect()` calls in
 *     flight at once;
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

export interface StreamLike {
  getTracks(): { stop(): void }[];
}

export interface VideoLike {
  srcObject: unknown;
  readyState: number;
  play(): Promise<void> | void;
}

export interface DetectorLike {
  detect(source: VideoLike): Promise<{ rawValue: string }[]>;
}

export interface ScanSessionDeps {
  env: ScannerEnvironment;
  getUserMedia(constraints: { video: { facingMode: string } }): Promise<StreamLike>;
  /** May be async (the WebAssembly decoder is loaded lazily). Started in parallel
   * with the permission prompt — both only after the user opened the scanner. */
  createDetector(): DetectorLike | Promise<DetectorLike>;
  getVideo(): VideoLike | null;
  /** Repeating timer; returns its cancel function. */
  every(ms: number, tick: () => void): () => void;
  onPhase(phase: ScanPhase): void;
  /** Called at most once per session, with a trimmed, non-empty code. */
  onDetect(code: string): void;
}

export const DETECT_INTERVAL_MS = 300;
/** HTMLMediaElement.HAVE_CURRENT_DATA — a frame is available to decode. */
const HAVE_CURRENT_DATA = 2;

export function startScanSession(deps: ScanSessionDeps): { stop(): void } {
  let stopped = false;
  let detected = false;
  let inFlight = false;
  let stream: StreamLike | null = null;
  let cancelTimer: (() => void) | null = null;
  let attachedTo: VideoLike | null = null;

  const releaseCamera = () => {
    if (cancelTimer) {
      cancelTimer();
      cancelTimer = null;
    }
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
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
        (detector) => {
          detectorReady = true;
          return { ok: true as const, detector };
        },
        () => {
          detectorReady = true;
          return { ok: false as const };
        }
      );

    let s: StreamLike;
    try {
      s = await deps.getUserMedia({ video: { facingMode: "environment" } });
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

    attachIfNeeded();
    if (!detectorReady) deps.onPhase({ kind: "loading" });
    const loaded = await detectorPromise;
    if (stopped) return; // stop() already released the camera
    if (!loaded.ok) {
      releaseCamera();
      deps.onPhase({ kind: "error", errorKind: "decoder-unavailable" });
      return;
    }
    const detector = loaded.detector;

    deps.onPhase({ kind: "scanning" });
    cancelTimer = deps.every(DETECT_INTERVAL_MS, () => {
      if (stopped || detected || inFlight) return;
      const video = attachIfNeeded();
      if (!video || video.readyState < HAVE_CURRENT_DATA) return;
      inFlight = true;
      detector
        .detect(video)
        .then((codes) => {
          if (stopped || detected) return;
          const code = codes.map((c) => c.rawValue?.trim() ?? "").find((c) => c.length > 0);
          if (!code) return;
          detected = true;
          releaseCamera();
          deps.onPhase({ kind: "detected", code });
          deps.onDetect(code);
        })
        .catch(() => {
          // One frame failed to decode — not fatal, the next tick retries.
        })
        .finally(() => {
          inFlight = false;
        });
    });
  })();

  return { stop };
}
