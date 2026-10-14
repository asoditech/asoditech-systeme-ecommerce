import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Sparkline } from "@/components/sparkline";
import { TrendBadge } from "@/components/kpi-card";
import { MetricInfo } from "@/components/metric-info";
import type { MetricKey } from "@/lib/metrics/glossary";

// Literal, statically-scannable class strings — Tailwind's build-time scanner
// cannot see a dynamically interpolated `sm:grid-cols-${n}` class name, so
// the column count must be one of these known literals, never built as a string.
const STAT_COLS: Record<1 | 2 | 3 | 4, string> = {
  1: "sm:grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-4",
};

const STAT_CHIPS = [
  "bg-pill-peach text-pill-peach-fg",
  "bg-pill-blue text-pill-blue-fg",
  "bg-pill-green text-pill-green-fg",
  "bg-pill-purple text-pill-purple-fg",
] as const;

/**
 * "Command Hero" — the dashboard's headline surface (the large overview card
 * of the bento grid).
 *
 * Soft UI (redesign/soft-ui): a plain white card — the eyebrow is the card
 * title with its pastel bar, the headline figure is the page's one 48px
 * number (dark text, tabular), the sparkline is a smooth orange line, and
 * the secondary stats sit in soft grey tiles with pastel icon chips.
 *
 * Real data only: every number is exactly what the caller already
 * computed elsewhere on the page (no second query, no fabricated trend).
 */
export function CommandHero({
  eyebrow,
  label,
  value,
  hint,
  info,
  explain,
  trend,
  sparklineData,
  stats,
}: {
  eyebrow: string;
  label: string;
  value: string;
  hint?: string;
  /** « ⓘ » explanation of the headline metric. */
  info?: MetricKey;
  /** Any other « ⓘ » for the headline (e.g. <ReportMetricInfo/> on /rapports). */
  explain?: React.ReactNode;
  trend?: { direction: "up" | "down" | "flat"; label: string };
  /** Real values already fetched elsewhere on the page — omit for no sparkline. */
  sparklineData?: { value: number }[];
  stats: { label: string; value: string; icon: LucideIcon; explain?: React.ReactNode }[];
}) {
  return (
    <div className="flex flex-col gap-6 rounded-card bg-card p-5 shadow-card sm:p-6">
      <div className="flex flex-col gap-6 2xl:flex-row 2xl:items-end 2xl:justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-3 text-lg leading-snug font-semibold text-ink">
            <span aria-hidden="true" className="h-6 w-1.5 shrink-0 rounded-full bg-pastel-peach" />
            {eyebrow}
          </p>
          <p className="mt-5 flex items-center gap-1 text-sm text-ink-secondary">
            {label}
            {info && <MetricInfo metric={info} />}
            {explain}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            <p className="text-[32px] leading-none font-semibold tracking-tight break-words text-ink tabular-nums sm:text-[48px]">{value}</p>
            {trend && <TrendBadge trend={trend} />}
          </div>
          {hint && <p className="mt-2 text-xs text-ink-muted">{hint}</p>}
        </div>
        {sparklineData && sparklineData.length > 1 && (
          <div className="w-full shrink-0 2xl:w-72">
            <Sparkline id="command-hero-spark" data={sparklineData} color="var(--chart-1)" height={80} />
          </div>
        )}
      </div>

      {stats.length > 0 && (
        <div className={cn("grid grid-cols-1 gap-3", STAT_COLS[Math.min(stats.length, 4) as 1 | 2 | 3 | 4])}>
          {stats.map((s, i) => (
            <div key={s.label} className="flex min-w-0 items-center gap-3 rounded-tile bg-content p-4 sm:flex-col sm:items-start">
              <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", STAT_CHIPS[i % STAT_CHIPS.length])}>
                <s.icon className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="flex items-start gap-0.5 text-xs text-ink-muted">
                  <span className="line-clamp-2">{s.label}</span>
                  {s.explain}
                </p>
                <p className="mt-1 truncate text-xl font-semibold text-ink tabular-nums sm:text-2xl">{s.value}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
