import { cn } from "@/lib/utils";

export type NavBadgeTone = "peach" | "green" | "blue" | "purple" | "yellow";

const TONES: Record<NavBadgeTone, string> = {
  peach: "bg-pastel-peach",
  green: "bg-pastel-green",
  blue: "bg-pastel-blue",
  purple: "bg-pastel-purple",
  yellow: "bg-pastel-yellow",
};

/**
 * Small rounded-square pastel count chip for a sidebar row (Soft UI). Purely
 * presentational: renders nothing without a positive `count`, and is NOT wired
 * to any data yet — real counts (orders to confirm, returns…) are a separate,
 * later phase.
 */
export function NavBadge({ count, tone = "peach", className }: { count?: number | null; tone?: NavBadgeTone; className?: string }) {
  if (count == null || !Number.isFinite(count) || count <= 0) return null;
  const label = count > 99 ? "99+" : String(Math.floor(count));
  return (
    <span
      data-slot="nav-badge"
      className={cn(
        "inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-lg px-1.5 text-xs font-semibold text-[#1a1a1a] tabular-nums",
        TONES[tone],
        className
      )}
    >
      {label}
    </span>
  );
}
