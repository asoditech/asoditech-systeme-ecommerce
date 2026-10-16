import Link from "next/link";
import { cn } from "@/lib/utils";
import { ScrollFade } from "@/components/ui/scroll-fade";

/**
 * Phase 4 (Complete Product UI/UX Visual Redesign) — a pill-shaped
 * segmented control for a small, mutually-exclusive set of choices (a
 * period picker, a channel filter, a chart-range toggle). Replaces the
 * previous loose row of individually-bordered `<Button variant="outline">`
 * elements: those read as "a list of buttons that happen to relate to each
 * other"; a segmented control reads as ONE control with several positions
 * — the pattern virtually every modern SaaS product uses for exactly this
 * (period/range pickers). Each item is a real `<Link>` (these are all
 * URL-driven filters, never client state) so the existing server-rendered,
 * no-JS-required navigation is unchanged — purely a visual regrouping.
 */
export function SegmentedControl({ children, className }: { children: React.ReactNode; className?: string }) {
  // max-w-full + own horizontal scroll: on a phone a 5-position period
  // picker scrolls inside itself instead of being clipped at the edge. The
  // inner ScrollFade fades the edge that hides positions (no hidden choice
  // without a hint) and brings the active position into view.
  return (
    <div className={cn("inline-flex max-w-full overflow-hidden rounded-full bg-segment-track", className)}>
      <ScrollFade
        revealActive
        className="flex min-w-0 items-center gap-0.5 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </ScrollFade>
    </div>
  );
}

export function SegmentedControlItem({
  active,
  href,
  children,
}: {
  active: boolean;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={cn(
        "inline-flex h-8 items-center rounded-full px-3.5 text-[13px] font-medium whitespace-nowrap transition-[color,background-color,box-shadow] duration-150 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25 motion-reduce:transition-none",
        active ? "bg-segment-thumb text-ink shadow-soft" : "text-ink-secondary hover:text-ink"
      )}
    >
      {children}
    </Link>
  );
}
