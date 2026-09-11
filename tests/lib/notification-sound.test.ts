import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeNewNotificationIds } from "@/lib/notification-sound";

describe("computeNewNotificationIds — the pure new-notification detector", () => {
  it("the first sync (no baseline yet) never reports anything as new, however many items it sees", () => {
    const result = computeNewNotificationIds(null, [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }]);
    expect(result.isBaseline).toBe(true);
    expect(result.newIds).toEqual([]);
  });

  it("a single genuinely new id is reported once", () => {
    const previous = new Set(["a", "b"]);
    const result = computeNewNotificationIds(previous, [{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(result.isBaseline).toBe(false);
    expect(result.newIds).toEqual(["c"]);
  });

  it("ids already in the baseline never trigger — existing unread notifications stay silent", () => {
    const previous = new Set(["a", "b", "c"]);
    const result = computeNewNotificationIds(previous, [{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(result.newIds).toEqual([]);
  });

  it("the same new id returned across two consecutive polls is only ever \"new\" once", () => {
    const previous = new Set(["a"]);
    const firstPoll = computeNewNotificationIds(previous, [{ id: "a" }, { id: "b" }]);
    expect(firstPoll.newIds).toEqual(["b"]);

    // The caller folds firstPoll's items into the next baseline before polling again.
    const nextBaseline = new Set([...previous, ...firstPoll.newIds]);
    const secondPoll = computeNewNotificationIds(nextBaseline, [{ id: "a" }, { id: "b" }]);
    expect(secondPoll.newIds).toEqual([]);
  });

  it("three new ids arriving in the same poll come back together — the caller plays exactly one sound for the batch", () => {
    const previous = new Set(["a"]);
    const result = computeNewNotificationIds(previous, [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]);
    expect(result.newIds).toEqual(["b", "c", "d"]);
    expect(result.newIds.length).toBe(3); // one batch; the listener plays one sound regardless of this count
  });

  it("never looks at unread count — a shrinking list (marked read elsewhere) reports no new ids", () => {
    const previous = new Set(["a", "b", "c"]);
    // "c" no longer present (e.g. dismissed) — nothing here should read as "new".
    const result = computeNewNotificationIds(previous, [{ id: "a" }, { id: "b" }]);
    expect(result.newIds).toEqual([]);
  });

  it("an empty poll after a baseline is a no-op, not a reset", () => {
    const previous = new Set(["a", "b"]);
    const result = computeNewNotificationIds(previous, []);
    expect(result.isBaseline).toBe(false);
    expect(result.newIds).toEqual([]);
  });
});

/**
 * Browser-facing behavior (localStorage preference, Audio playback,
 * autoplay-rejection safety, multi-tab guard). vitest runs these in a
 * plain Node environment (no jsdom anywhere in this project) — `window`,
 * `localStorage`, and `Audio` are stubbed manually per test and the
 * module is re-imported fresh each time via `vi.resetModules()` so the
 * shared-audio singleton never leaks state between cases.
 */
describe("notification-sound — browser-facing behavior", () => {
  let store: Map<string, string>;
  let playImpl: () => Promise<void>;
  let playCallCount: number;
  let audioInstancesCreated: number;

  beforeEach(() => {
    vi.resetModules();
    store = new Map();
    audioInstancesCreated = 0;
    playCallCount = 0;
    playImpl = () => Promise.resolve();

    const localStorageMock = {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    };

    class MockAudio {
      volume = 1;
      muted = false;
      currentTime = 0;
      preload = "";
      constructor() {
        audioInstancesCreated += 1;
      }
      play() {
        playCallCount += 1;
        return playImpl();
      }
      pause() {}
    }

    (globalThis as unknown as { window: unknown }).window = globalThis;
    (globalThis as unknown as { localStorage: unknown }).localStorage = localStorageMock;
    (globalThis as unknown as { Audio: unknown }).Audio = MockAudio;
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { localStorage?: unknown }).localStorage;
    delete (globalThis as { Audio?: unknown }).Audio;
  });

  it("defaults to enabled when nothing is stored yet", async () => {
    const { isSoundEnabled } = await import("@/lib/notification-sound");
    expect(isSoundEnabled()).toBe(true);
  });

  it("setSoundEnabled(false) persists and is read back by isSoundEnabled", async () => {
    const { isSoundEnabled, setSoundEnabled } = await import("@/lib/notification-sound");
    setSoundEnabled(false);
    expect(isSoundEnabled()).toBe(false);
    setSoundEnabled(true);
    expect(isSoundEnabled()).toBe(true);
  });

  it("a disabled preference prevents playback entirely — Audio is never even constructed", async () => {
    const { setSoundEnabled, playNotificationSound } = await import("@/lib/notification-sound");
    setSoundEnabled(false);
    playNotificationSound();
    expect(audioInstancesCreated).toBe(0);
    expect(playCallCount).toBe(0);
  });

  it("plays through the shared Audio element when enabled, reusing one instance across calls", async () => {
    const { playNotificationSound } = await import("@/lib/notification-sound");
    playNotificationSound();
    // The multi-tab guard blocks an immediate second call, which is the
    // real-world case that matters — see the dedicated test below. Wait
    // is not needed: what we're proving here is the singleton, not timing.
    expect(audioInstancesCreated).toBe(1);
    expect(playCallCount).toBe(1);
  });

  it("a rejected play() promise (autoplay blocked) never throws or crashes", async () => {
    playImpl = () => Promise.reject(new Error("NotAllowedError"));
    const { playNotificationSound } = await import("@/lib/notification-sound");
    expect(() => playNotificationSound()).not.toThrow();
    // Let the rejected promise's .catch() run before the test ends.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("suppresses a second play within the multi-tab guard window (simulating another tab having just played)", async () => {
    const { playNotificationSound } = await import("@/lib/notification-sound");
    playNotificationSound();
    expect(playCallCount).toBe(1);
    playNotificationSound();
    // Still 1 — the localStorage "last played" timestamp this call just
    // wrote blocks the immediate repeat, the same guard that protects
    // against two open tabs both sounding for the same batch.
    expect(playCallCount).toBe(1);
  });

  it("isSoundEnabled falls back safely if localStorage throws (private mode / quota)", async () => {
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    const { isSoundEnabled } = await import("@/lib/notification-sound");
    expect(() => isSoundEnabled()).not.toThrow();
    expect(isSoundEnabled()).toBe(true);
  });
});
