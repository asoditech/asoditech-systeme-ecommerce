"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * A thin loading bar across the top of the viewport during client-side
 * navigation, so a click always gets immediate feedback even when the
 * destination takes a moment to render.
 *
 * The App Router exposes no router events, so navigation *start* is caught
 * by patching `history.pushState` / `replaceState` (the technique
 * nextjs-toploader and @bprogress use) and *completion* by the committed
 * `pathname` + `searchParams` changing. Respects `prefers-reduced-motion`.
 */
export function TopProgressBar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // null = hidden; a number = current width percentage.
  const [width, setWidth] = useState<number | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // True between a navigation starting and the route committing — guards
  // the completion effect against firing on mount or on an unrelated
  // re-render.
  const navigating = useRef(false);

  const clearTrickle = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  // --- navigation start ---
  useEffect(() => {
    const origPush = history.pushState;
    const origReplace = history.replaceState;

    const begin = () => {
      clearTrickle();
      navigating.current = true;
      setWidth(8);
      timers.current.push(setTimeout(() => setWidth(38), 120));
      timers.current.push(setTimeout(() => setWidth(65), 450));
      timers.current.push(setTimeout(() => setWidth(84), 1400));
    };

    history.pushState = function (...args: Parameters<typeof origPush>) {
      begin();
      return origPush.apply(this, args);
    };
    history.replaceState = function (...args: Parameters<typeof origReplace>) {
      begin();
      return origReplace.apply(this, args);
    };
    window.addEventListener("popstate", begin);

    return () => {
      history.pushState = origPush;
      history.replaceState = origReplace;
      window.removeEventListener("popstate", begin);
      clearTrickle();
    };
  }, []);

  // --- navigation committed → finish ---
  useEffect(() => {
    if (!navigating.current) return;
    navigating.current = false;
    clearTrickle();
    const fill = setTimeout(() => setWidth(100), 0);
    const hide = setTimeout(() => setWidth(null), 260);
    return () => {
      clearTimeout(fill);
      clearTimeout(hide);
    };
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
