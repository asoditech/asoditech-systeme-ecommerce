import Link from "next/link";
import { cn } from "@/lib/utils";

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
  // picker scrolls inside itself instead of being clipped at the edge.
  return (
    <div
      className={cn(
        "inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full bg-muted p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className
      )}
    >
      {children}
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
        "rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        active ? "bg-background text-foreground shadow-sm ring-1 ring-[color-mix(in_oklch,var(--input),var(--foreground)_12%)]" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </Link>
  );
}
