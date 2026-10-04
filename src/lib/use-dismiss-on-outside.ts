"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Closes an inline dropdown-like list (product picker results) when the user
 * presses outside `ref` or hits Escape — only while `active`. A press INSIDE
 * (the field, the list, its buttons) never closes it, so picking an item
 * still works. The latest `onDismiss` is always used without re-subscribing.
 */
export function useDismissOnOutside(ref: RefObject<HTMLElement | null>, active: boolean, onDismiss: () => void): void {
  const latest = useRef(onDismiss);
  useEffect(() => {
    latest.current = onDismiss;
  });
  useEffect(() => {
    if (!active) return;
    function onPointerDown(e: PointerEvent) {
      const el = ref.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) latest.current();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") latest.current();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [active, ref]);
}
