"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/** Width (px) of the edge fade that hints « there is more this way ». */
export const SCROLL_FADE_PX = 24

export interface HorizontalOverflow {
  /** Content is hidden to the left (the user has scrolled right). */
  start: boolean
  /** Content is hidden to the right. */
  end: boolean
}

/**
 * Which edges of a horizontal scroller hide content. Pure (tested). A 1px
 * tolerance absorbs sub-pixel rounding so a fitting row never shows a fade.
 * `Math.abs` keeps it right for RTL scrollers, whose scrollLeft is ≤ 0.
 */
export function horizontalOverflow(scrollLeft: number, scrollWidth: number, clientWidth: number): HorizontalOverflow {
  const hidden = scrollWidth - clientWidth
  if (hidden <= 1) return { start: false, end: false }
  const left = Math.abs(scrollLeft)
  return { start: left > 1, end: left < hidden - 1 }
}

/**
 * CSS mask that fades the content out at each overflowing edge. A mask (not
 * a coloured gradient overlay) works on any background — white table card,
 * grey segmented track, dark mode — with no colour to keep in sync.
 */
export function scrollFadeMask({ start, end }: HorizontalOverflow): string | undefined {
  if (!start && !end) return undefined
  const a = start ? SCROLL_FADE_PX : 0
  const b = end ? SCROLL_FADE_PX : 0
  return `linear-gradient(to right, transparent 0, #000 ${a}px, #000 calc(100% - ${b}px), transparent 100%)`
}

/**
 * The `scrollLeft` that brings `child` fully into view inside a scroller,
 * or null when it already is. Pure (tested). Used instead of
 * `scrollIntoView`, which would also scroll the page vertically.
 */
export function scrollLeftToReveal(
  view: { scrollLeft: number; clientWidth: number },
  child: { offsetLeft: number; offsetWidth: number },
  margin = SCROLL_FADE_PX
): number | null {
  const left = child.offsetLeft - margin
  const right = child.offsetLeft + child.offsetWidth + margin
  if (left < view.scrollLeft) return Math.max(0, left)
  if (right > view.scrollLeft + view.clientWidth) return right - view.clientWidth
  return null
}

const ACTIVE_SELECTOR = '[aria-current]:not([aria-current="false"]), [data-active]:not([data-active="false"])'

type ScrollFadeProps = React.ComponentProps<"div"> & {
  /**
   * Accessible name of the scroll region. When the content overflows the
   * container becomes a keyboard-focusable `role="region"` so it can be
   * scrolled with the arrow keys (WCAG 2.1.1) — only then, never an empty
   * tab stop on a row that fits.
   */
  label?: string
  /** Scroll the active child (`aria-current` / `data-active`) into view on mount and on change. */
  revealActive?: boolean
}

/**
 * Horizontal scroller that shows a soft edge fade only on the side(s) where
 * content is hidden. Shared by the table container (src/components/ui/table.tsx)
 * and the section tab rows (/analyses, /parametres).
 */
function ScrollFade({ label, revealActive = false, className, style, children, ...props }: ScrollFadeProps) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = React.useState<HorizontalOverflow>({ start: false, end: false })

  const measure = React.useCallback(() => {
    const el = ref.current
    if (!el) return
    const next = horizontalOverflow(el.scrollLeft, el.scrollWidth, el.clientWidth)
    setOverflow((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
  }, [])

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    measure()
    el.addEventListener("scroll", measure, { passive: true })
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null
    ro?.observe(el)
    for (const child of Array.from(el.children)) ro?.observe(child)
    return () => {
      el.removeEventListener("scroll", measure)
      ro?.disconnect()
    }
  }, [measure])

  // Only when the active item CHANGES (mount, navigation) — never on a
  // re-render caused by the user's own scrolling.
  const revealed = React.useRef<Element | null>(null)
  React.useEffect(() => {
    if (!revealActive) return
    const el = ref.current
    const active = el?.querySelector<HTMLElement>(ACTIVE_SELECTOR)
    if (!el || !active || active === revealed.current) return
    revealed.current = active
    // offsetLeft is relative to the offsetParent: measure against the scroller.
    const offsetLeft = active.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft
    const target = scrollLeftToReveal(el, { offsetLeft, offsetWidth: active.offsetWidth })
    if (target !== null) el.scrollLeft = target
    measure()
  })

  const overflowing = overflow.start || overflow.end
  const mask = scrollFadeMask(overflow)

  return (
    <div
      ref={ref}
      data-overflow={overflowing ? [overflow.start && "start", overflow.end && "end"].filter(Boolean).join(" ") : undefined}
      {...(overflowing && label ? { role: "region", "aria-label": label, tabIndex: 0 } : {})}
      className={cn(
        "overflow-x-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        className
      )}
      style={mask ? { ...style, maskImage: mask, WebkitMaskImage: mask } : style}
      {...props}
    >
      {children}
    </div>
  )
}

export { ScrollFade }
