"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * A thin loading bar across the top of the viewport during client-side
 * navigation, so a click always gets immediate feedback even when the
 * destination takes a moment to render.
 *
 * The App Router exposes no router events, so navigation *start* is caught
 * by patching `history.pushState` — only real pushes; `replaceState` and
 * `router.refresh()` are in-place updates that must not start the bar —
 * and *completion* by the committed `pathname` + `searchParams` changing.
 * A hard fallback finishes the bar after a few seconds so it can never
 * stay stuck when a navigation resolves to the same URL. Respects
 * `prefers-reduced-motion`.
 */
const TRICKLE = [
  { at: 120, to: 38 },
  { at: 450, to: 65 },
  { at: 1400, to: 84 },
];
const FALLBACK_MS = 7000;

export function TopProgressBar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // null = hidden; a number = current width percentage.
  const [width, setWidth] = useState<number | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const navigating = useRef(false);
  // The route-change effect calls this to end an in-flight bar.
  const finishRef = useRef<() => void>(() => {});

  useEffect(() => {
    const origPush = history.pushState;

    const clearTimers = () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };

    const finish = () => {
      if (!navigating.current) return;
      navigating.current = false;
      clearTimers();
      timers.current.push(setTimeout(() => setWidth(100), 0));
      timers.current.push(setTimeout(() => setWidth(null), 260));
    };
    finishRef.current = finish;

    const begin = () => {
      clearTimers();
      navigating.current = true;
      setWidth(8);
      for (const step of TRICKLE) {
        timers.current.push(setTimeout(() => setWidth(step.to), step.at));
      }
      timers.current.push(setTimeout(finish, FALLBACK_MS));
    };

    history.pushState = function (...args: Parameters<typeof origPush>) {
      begin();
      return origPush.apply(this, args);
    };
    window.addEventListener("popstate", begin);

    return () => {
      history.pushState = origPush;
      window.removeEventListener("popstate", begin);
      clearTimers();
    };
  }, []);

  // The committed route changed → end any in-flight bar.
  useEffect(() => {
    finishRef.current();
  }, [pathname, searchParams]);

  if (width === null) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-0.5" aria-hidden>
      <div
        className="h-full rounded-r-full bg-primary shadow-[0_0_10px_0] shadow-primary/60 transition-[width] duration-300 ease-out motion-reduce:transition-none"
        style={{ width: `${width}%` }}
      />
    </div>
  );
}
