import { describe, expect, it } from "vitest";
import {
  CONTINUOUS_DEBOUNCE_MS,
  startScanSession,
  type ScanPhase,
  type ScanSessionDeps,
  type VideoLike,
} from "@/lib/barcode-scanner/session";
import { CAMERA_CONSTRAINTS, cameraFeaturesFrom, type CameraFeatures } from "@/lib/barcode-scanner/support";

/**
 * src/lib/barcode-scanner/session.ts — the camera-scan lifecycle with fake
 * browser APIs (no camera hardware in CI). The real-device behaviour still
 * needs a manual check on a phone (see the batch report).
 */

const SUPPORTED = { isSecureContext: true, hasMediaDevices: true, hasBarcodeDetector: true };

function fakeStream() {
  const tracks = [{ stopped: 0, stop() { this.stopped++; } }];
  return { tracks, getTracks: () => tracks };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function harness(overrides: Partial<ScanSessionDeps> = {}) {
  const phases: ScanPhase[] = [];
  const detected: string[] = [];
  const ticks: (() => void)[] = [];
  let timerCancelled = 0;
  const stream = fakeStream();
  let gumCalls = 0;
  const video: VideoLike = { srcObject: null, readyState: 4, play: () => Promise.resolve() };
  const deps: ScanSessionDeps = {
    env: SUPPORTED,
    getUserMedia: async () => {
      gumCalls++;
      return stream;
    },
    createDetector: () => ({ detect: async () => [] }),
    getVideo: () => video,
    every: (_ms, tick) => {
      ticks.push(tick);
      return () => {
        timerCancelled++;
      };
    },
    onPhase: (p) => phases.push(p),
    onDetect: (c) => detected.push(c),
    ...overrides,
  };
  return {
    deps,
    phases,
    detected,
    stream,
    video,
    tick: () => ticks.forEach((t) => t()),
    get gumCalls() {
      return gumCalls;
    },
    get timerCancelled() {
      return timerCancelled;
    },
  };
}

describe("startScanSession", () => {
  it("insecure context (plain http): never asks for the camera, reports insecure-context", async () => {
    const h = harness({ env: { ...SUPPORTED, isSecureContext: false, hasMediaDevices: false } });
    startScanSession(h.deps);
    await flush();
    expect(h.gumCalls).toBe(0);
    expect(h.phases).toEqual([{ kind: "unsupported", reason: "insecure-context" }]);
  });

  it("no BarcodeDetector (Safari/iOS, Firefox): never asks for the camera, reports unsupported-detector", async () => {
    const h = harness({ env: { ...SUPPORTED, hasBarcodeDetector: false } });
    startScanSession(h.deps);
    await flush();
    expect(h.gumCalls).toBe(0);
    expect(h.phases).toEqual([{ kind: "unsupported", reason: "unsupported-detector" }]);
  });

  it("permission denied: error phase, no stream left open", async () => {
    const err = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    const h = harness({ getUserMedia: async () => Promise.reject(err) });
    startScanSession(h.deps);
    await flush();
    expect(h.phases.at(-1)).toEqual({ kind: "error", errorKind: "permission-denied" });
  });

  it("no camera: error phase no-camera", async () => {
    const err = Object.assign(new Error("none"), { name: "NotFoundError" });
    const h = harness({ getUserMedia: async () => Promise.reject(err) });
    startScanSession(h.deps);
    await flush();
    expect(h.phases.at(-1)).toEqual({ kind: "error", errorKind: "no-camera" });
  });

  it("attaches the stream to the video and reaches the scanning phase", async () => {
    const h = harness();
    startScanSession(h.deps);
    await flush();
    expect(h.video.srcObject).toBe(h.stream);
    // "loading" may flash between the two when the decoder settles after the camera.
    expect(h.phases.map((p) => p.kind).filter((k) => k !== "loading")).toEqual(["starting", "scanning"]);
  });

  it("slow decoder (first WebAssembly load on iPhone): camera shown with a loading phase, then scanning", async () => {
    const load = deferred<{ detect: () => Promise<{ rawValue: string }[]> }>();
    const h = harness({ createDetector: () => load.promise });
    startScanSession(h.deps);
    await flush();
    expect(h.video.srcObject).toBe(h.stream); // preview already live
    expect(h.phases.map((p) => p.kind)).toEqual(["starting", "loading"]);
    load.resolve({ detect: async () => [] });
    await flush();
    expect(h.phases.at(-1)).toEqual({ kind: "scanning" });
  });

  it("decoder load fails (e.g. network): camera released, « decoder-unavailable », no detection", async () => {
    const h = harness({ createDetector: () => Promise.reject(new Error("wasm fetch failed")) });
    startScanSession(h.deps);
    await flush();
    expect(h.stream.tracks[0].stopped).toBe(1);
    expect(h.video.srcObject).toBeNull();
    expect(h.phases.at(-1)).toEqual({ kind: "error", errorKind: "decoder-unavailable" });
  });

  it("closed while the decoder is still loading: camera released, nothing reported after close", async () => {
    const load = deferred<{ detect: () => Promise<{ rawValue: string }[]> }>();
    const h = harness({ createDetector: () => load.promise });
    const s = startScanSession(h.deps);
    await flush();
    s.stop();
    load.resolve({ detect: async () => [{ rawValue: "X" }] });
    await flush();
    expect(h.stream.tracks[0].stopped).toBe(1);
    expect(h.phases.map((p) => p.kind)).toEqual(["starting", "loading"]);
    expect(h.detected).toEqual([]);
  });

  it("video mounted LATE (regression: it used to be captured once, up front): attached on a later tick", async () => {
    let mounted: VideoLike | null = null;
    const h = harness({ getVideo: () => mounted });
    startScanSession(h.deps);
    await flush();
    mounted = { srcObject: null, readyState: 4, play: () => Promise.resolve() };
    h.tick();
    expect(mounted.srcObject).toBe(h.stream);
  });

  it("calls onDetect ONCE with the trimmed code, then releases the camera — even if two detections resolve", async () => {
    const first = deferred<{ rawValue: string }[]>();
    let calls = 0;
    const h = harness({
      createDetector: () => ({
        detect: () => {
          calls++;
          return first.promise;
        },
      }),
    });
    startScanSession(h.deps);
    await flush();
    h.tick();
    h.tick(); // a detect is already in flight: no second call
    expect(calls).toBe(1);
    first.resolve([{ rawValue: "  6111234567890 " }, { rawValue: "999" }]);
    await flush();
    h.tick(); // after a detection nothing runs again
    await flush();
    expect(h.detected).toEqual(["6111234567890"]);
    expect(calls).toBe(1);
    expect(h.stream.tracks[0].stopped).toBe(1);
    expect(h.video.srcObject).toBeNull();
    expect(h.phases.at(-1)).toEqual({ kind: "detected", code: "6111234567890" });
  });

  it("ignores empty decodes and per-frame decode errors, keeps scanning", async () => {
    let n = 0;
    const h = harness({
      createDetector: () => ({
        detect: async () => {
          n++;
          if (n === 1) throw new Error("frame");
          if (n === 2) return [{ rawValue: "   " }];
          return [{ rawValue: "ABC-1" }];
        },
      }),
    });
    startScanSession(h.deps);
    await flush();
    for (let i = 0; i < 3; i++) {
      h.tick();
      await flush();
    }
    expect(h.detected).toEqual(["ABC-1"]);
  });

  it("does not decode before the video has a frame", async () => {
    let calls = 0;
    const h = harness({ createDetector: () => ({ detect: async () => (calls++, []) }) });
    h.video.readyState = 1;
    startScanSession(h.deps);
    await flush();
    h.tick();
    expect(calls).toBe(0);
  });

  it("stop() releases the camera and the timer, and is idempotent", async () => {
    const h = harness();
    const s = startScanSession(h.deps);
    await flush();
    s.stop();
    s.stop();
    expect(h.stream.tracks[0].stopped).toBe(1);
    expect(h.timerCancelled).toBe(1);
    expect(h.video.srcObject).toBeNull();
  });

  it("closed while the permission prompt is open: the late stream is stopped, nothing is attached", async () => {
    const gum = deferred<ReturnType<typeof fakeStream>>();
    const late = fakeStream();
    const h = harness({ getUserMedia: () => gum.promise });
    const s = startScanSession(h.deps);
    await flush();
    s.stop();
    gum.resolve(late);
    await flush();
    expect(late.tracks[0].stopped).toBe(1);
    expect(h.video.srcObject).toBeNull();
    expect(h.phases.map((p) => p.kind)).toEqual(["starting"]);
  });

  it("a detector that cannot be created releases the camera and shows an error", async () => {
    const h = harness({
      createDetector: () => {
        throw new Error("boom");
      },
    });
    startScanSession(h.deps);
    await flush();
    expect(h.stream.tracks[0].stopped).toBe(1);
    expect(h.phases.at(-1)).toEqual({ kind: "error", errorKind: "decoder-unavailable" });
    expect(h.detected).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — constraints, device capabilities, « Scanner maintenant », modes
// ---------------------------------------------------------------------------


/** A camera track reporting `caps`; records every applyConstraints call (optionally rejecting). */
function cameraStream(caps: Record<string, unknown> | null, opts: { rejectApply?: boolean } = {}) {
  const applied: Record<string, unknown>[] = [];
  const track = {
    kind: "video",
    stopped: 0,
    stop() {
      this.stopped++;
    },
    ...(caps ? { getCapabilities: () => caps } : {}),
    applyConstraints: async (c: { advanced: Record<string, unknown>[] }) => {
      if (opts.rejectApply) throw new Error("OverconstrainedError");
      applied.push(...c.advanced);
    },
  };
  return { track, applied, stream: { getTracks: () => [track] } };
}

/** Detector whose next answers are queued; empty queue = nothing found. */
function queuedDetector() {
  const queue: string[][] = [];
  let calls = 0;
  return {
    push: (...codes: string[]) => queue.push(codes),
    get calls() {
      return calls;
    },
    detector: { detect: async () => (calls++, (queue.shift() ?? []).map((rawValue) => ({ rawValue }))) },
  };
}

describe("startScanSession — camera request and device capabilities", () => {
  it("asks for the rear camera at a HIGHER ideal resolution (never a hard requirement)", async () => {
    let asked: unknown = null;
    const h = harness({ getUserMedia: async (c) => ((asked = c), fakeStream()) });
    startScanSession(h.deps);
    await flush();
    expect(asked).toEqual(CAMERA_CONSTRAINTS);
    expect(CAMERA_CONSTRAINTS.video).toEqual({ facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } });
  });

  it("continuous focus is switched on ONLY when the camera reports it", async () => {
    const supported = cameraStream({ focusMode: ["manual", "continuous"] });
    let features: CameraFeatures | null = null;
    const h1 = harness({ getUserMedia: async () => supported.stream, onFeatures: (f) => (features = f) });
    startScanSession(h1.deps);
    await flush();
    expect(supported.applied).toEqual([{ focusMode: "continuous" }]);
    expect(features).toMatchObject({ continuousFocus: true });

    const unsupported = cameraStream({ focusMode: ["manual"] });
    const h2 = harness({ getUserMedia: async () => unsupported.stream });
    startScanSession(h2.deps);
    await flush();
    expect(unsupported.applied).toEqual([]);

    // No getCapabilities at all (e.g. some Safari versions): nothing applied, scanning still starts.
    const none = cameraStream(null);
    const h3 = harness({ getUserMedia: async () => none.stream });
    startScanSession(h3.deps);
    await flush();
    expect(none.applied).toEqual([]);
    expect(h3.phases.at(-1)).toEqual({ kind: "scanning" });
  });

  it("a refused constraint never stops the scan", async () => {
    const cam = cameraStream({ focusMode: ["continuous"], torch: true }, { rejectApply: true });
    const h = harness({ getUserMedia: async () => cam.stream });
    const s = startScanSession(h.deps);
    await flush();
    expect(h.phases.at(-1)).toEqual({ kind: "scanning" });
    expect(await s.setTorch(true)).toBe(false);
  });

  it("zoom: applied (clamped to the reported range) only when supported", async () => {
    const cam = cameraStream({ zoom: { min: 1, max: 5, step: 0.1 } });
    let features: CameraFeatures | null = null;
    const h = harness({ getUserMedia: async () => cam.stream, onFeatures: (f) => (features = f) });
    const s = startScanSession(h.deps);
    await flush();
    expect(features).toMatchObject({ zoom: { min: 1, max: 5, step: 0.1 } });
    expect(await s.setZoom(2)).toBe(true);
    expect(await s.setZoom(99)).toBe(true);
    expect(cam.applied).toEqual([{ zoom: 2 }, { zoom: 5 }]);

    const noZoom = cameraStream({ focusMode: ["continuous"] });
    const h2 = harness({ getUserMedia: async () => noZoom.stream });
    const s2 = startScanSession(h2.deps);
    await flush();
    expect(await s2.setZoom(2)).toBe(false);
    expect(noZoom.applied).toEqual([{ focusMode: "continuous" }]);
  });

  it("torch: only when the camera reports it", async () => {
    const cam = cameraStream({ torch: true });
    const h = harness({ getUserMedia: async () => cam.stream });
    const s = startScanSession(h.deps);
    await flush();
    expect(await s.setTorch(true)).toBe(true);
    expect(cam.applied).toEqual([{ torch: true }]);

    const noTorch = cameraStream({ torch: false });
    const h2 = harness({ getUserMedia: async () => noTorch.stream });
    const s2 = startScanSession(h2.deps);
    await flush();
    expect(await s2.setTorch(true)).toBe(false);
    expect(noTorch.applied).toEqual([]);
  });

  it("after stop(): camera released, zoom/torch no longer applied", async () => {
    const cam = cameraStream({ zoom: { min: 1, max: 3 }, torch: true });
    const h = harness({ getUserMedia: async () => cam.stream });
    const s = startScanSession(h.deps);
    await flush();
    s.stop();
    expect(cam.track.stopped).toBe(1);
    expect(await s.setZoom(2)).toBe(false);
    expect(await s.setTorch(true)).toBe(false);
    expect(cam.applied).toEqual([]);
  });
});

describe("startScanSession — « Scanner maintenant » and modes", () => {
  it("scanNow() decodes the current frame immediately (no tick needed); single mode then releases the camera", async () => {
    const d = queuedDetector();
    const h = harness({ createDetector: () => d.detector });
    const s = startScanSession(h.deps);
    expect(await s.scanNow()).toBe("not-ready"); // decoder not ready yet
    await flush();
    expect(await s.scanNow()).toBe("none"); // nothing on this frame
    d.push(" 6111111111111 ");
    expect(await s.scanNow()).toBe("detected");
    expect(h.detected).toEqual(["6111111111111"]);
    expect(h.stream.tracks[0].stopped).toBe(1);
    expect(await s.scanNow()).toBe("not-ready"); // single mode: done
  });

  it("scanNow() while an automatic decode is in flight → busy (never two detects at once)", async () => {
    const pending = deferred<{ rawValue: string }[]>();
    let calls = 0;
    const h = harness({ createDetector: () => ({ detect: () => (calls++, pending.promise) }) });
    const s = startScanSession(h.deps);
    await flush();
    h.tick();
    expect(await s.scanNow()).toBe("busy");
    expect(calls).toBe(1);
    pending.resolve([]);
  });

  it("single mode (default): one code, camera released — unchanged for existing callers", async () => {
    const d = queuedDetector();
    const h = harness({ createDetector: () => d.detector });
    startScanSession(h.deps);
    await flush();
    d.push("AAA");
    h.tick();
    await flush();
    d.push("BBB");
    h.tick();
    await flush();
    expect(h.detected).toEqual(["AAA"]);
    expect(h.stream.tracks[0].stopped).toBe(1);
  });

  it("continuous mode: every new code, the same code debounced, camera kept open until stop()", async () => {
    const d = queuedDetector();
    let clock = 1_000;
    const h = harness({ createDetector: () => d.detector, mode: "continuous", now: () => clock });
    const s = startScanSession(h.deps);
    await flush();

    const read = async (code: string) => {
      d.push(code);
      h.tick();
      await flush();
    };
    await read("AAA");
    await read("AAA"); // same code, immediately → ignored
    clock += CONTINUOUS_DEBOUNCE_MS - 1;
    await read("AAA"); // still inside the window → ignored
    await read("BBB"); // a different code → accepted
    clock += CONTINUOUS_DEBOUNCE_MS;
    await read("BBB"); // same code after the window → accepted again (2nd unit)
    expect(h.detected).toEqual(["AAA", "BBB", "BBB"]);
    expect(h.stream.tracks[0].stopped).toBe(0); // camera still open
    expect(h.phases.some((p) => p.kind === "detected")).toBe(false);

    d.push("BBB");
    expect(await s.scanNow()).toBe("duplicate");

    s.stop();
    expect(h.stream.tracks[0].stopped).toBe(1);
    expect(h.timerCancelled).toBe(1);
    expect(h.video.srcObject).toBeNull();
  });
});

describe("cameraFeaturesFrom", () => {
  it("only what the device reports — nothing assumed", () => {
    expect(cameraFeaturesFrom(null)).toEqual({ continuousFocus: false, zoom: null, torch: false });
    expect(cameraFeaturesFrom({})).toEqual({ continuousFocus: false, zoom: null, torch: false });
    expect(cameraFeaturesFrom({ focusMode: ["continuous"], zoom: { min: 1, max: 8, step: 0.5 }, torch: true })).toEqual({
      continuousFocus: true,
      zoom: { min: 1, max: 8, step: 0.5 },
      torch: true,
    });
    expect(cameraFeaturesFrom({ zoom: { min: 1, max: 1 } }).zoom).toBeNull(); // no real range
    expect(cameraFeaturesFrom({ zoom: { min: 1, max: 4 } }).zoom).toEqual({ min: 1, max: 4, step: 0.1 });
  });
});
