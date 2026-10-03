import { describe, expect, it } from "vitest";
import { startScanSession, type ScanPhase, type ScanSessionDeps, type VideoLike } from "@/lib/barcode-scanner/session";

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
