import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Sparkline } from "@/components/sparkline";
import { TrendBadge } from "@/components/kpi-card";

// Literal, statically-scannable class strings — Tailwind's build-time scanner
// cannot see a dynamically interpolated `sm:grid-cols-${n}` class name, so
// the column count must be one of these known literals, never built as a string.
const STAT_COLS: Record<1 | 2 | 3 | 4, string> = {
  1: "sm:grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-4",
};

/**
 * "Command Hero" — the dashboard's headline surface.
 *
 * Phase 5 visual QA: LIGHT by construction. The Phase 4 version was a dark
 * panel; ASODITECH is a light SaaS interface, so the headline now earns its
 * prominence through scale and hierarchy (the page's only 4xl figure, a
 * soft brand-tinted wash, a brand accent rail) instead of a black surface.
 * The number itself stays in dark foreground text — large orange text on
 * white fails contrast — and the brand color is carried by the accent rail,
 * the sparkline and the stat icons.
 *
 * Real data only: every number is exactly what the caller already
 * computed elsewhere on the page (no second query, no fabricated trend).
 */
export function CommandHero({
  eyebrow,
  label,
  value,
  hint,
  trend,
  sparklineData,
  stats,
}: {
  eyebrow: string;
  label: string;
  value: string;
  hint?: string;
  trend?: { direction: "up" | "down" | "flat"; label: string };
  /** Real values already fetched elsewhere on the page — omit for no sparkline. */
  sparklineData?: { value: number }[];
  stats: { label: string; value: string; icon: LucideIcon }[];
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-card shadow-card ring-1 ring-border">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-linear-to-br from-primary/8 via-transparent to-transparent" />
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-primary" />
      <div className="relative flex flex-col gap-5 p-5 sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold tracking-wide text-accent-foreground uppercase">{eyebrow}</p>
            <p className="mt-2 text-sm font-medium text-muted-foreground">{label}</p>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <p className="truncate text-3xl font-bold tracking-tight text-foreground tabular-nums sm:text-4xl">{value}</p>
              {trend && <TrendBadge trend={trend} />}
            </div>
            {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
          </div>
          {sparklineData && sparklineData.length > 1 && (
            <div className="w-full shrink-0 lg:w-64">
              <Sparkline id="command-hero-spark" data={sparklineData} color="var(--color-primary)" height={64} />
            </div>
          )}
        </div>

        {stats.length > 0 && (
          <div className={cn("grid grid-cols-1 gap-3", STAT_COLS[Math.min(stats.length, 4) as 1 | 2 | 3 | 4])}>
            {stats.map((s) => (
              <div key={s.label} className="flex items-center gap-3 rounded-xl border border-border/80 bg-background/70 px-3.5 py-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
                  <s.icon className="size-4" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-xs text-muted-foreground">{s.label}</p>
                  <p className="truncate text-base font-semibold tabular-nums">{s.value}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
