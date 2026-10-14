import type { LucideIcon } from "lucide-react";
import { ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { TONES, type Tone } from "@/lib/design/tone";
import { MetricInfo } from "@/components/metric-info";
import { AnalyticsMetricInfo } from "@/components/analytics/analytics-metric-info";
import type { MetricKey } from "@/lib/metrics/glossary";
import type { AnalyticsMetricId } from "@/lib/metrics/analytics-explanations";

export type KpiTone = Tone;

const TREND_ICON = { up: ArrowUpRight, down: ArrowDownRight, flat: Minus } as const;

/**
 * A dashboard/analytics KPI tile — "Compact KPI": the default, non-dominant
 * tile for a secondary metric. `value` is `null` when the metric genuinely
 * cannot be computed (missing data, no integration connected) — renders
 * "Non calculable" rather than fabricating a number. See the project's Data
 * Integrity Principle.
 *
 * Phase 5 visual QA: the Phase 4 decorative "floating icon" watermark and
 * hover lift are gone — a KPI tile is not clickable, so lifting on hover
 * signalled an action that doesn't exist, and the watermark was texture
 * with no meaning. The small tinted badge next to the label is the one
 * functional icon; `tone` only varies color (see src/lib/design/tone.ts)
 * and never implies a different data-integrity guarantee.
 */
export function KpiCard({
  label,
  value,
  icon: Icon,
  hint,
  trend,
  unavailableReason,
  tone = "primary",
  info,
  metric,
  explain,
  size = "default",
}: {
  label: string;
  value: string | null;
  icon?: LucideIcon;
  hint?: string;
  trend?: { direction: "up" | "down" | "flat"; label: string };
  unavailableReason?: string;
  tone?: KpiTone;
  /** « ⓘ » explanation of the metric (src/lib/metrics/glossary.ts). */
  info?: MetricKey;
  /** « ⓘ » explanation of an /analyses figure (src/lib/metrics/analytics-explanations.ts). */
  metric?: AnalyticsMetricId;
  /** Any other « ⓘ » (e.g. <ReportMetricInfo/> on /rapports). */
  explain?: React.ReactNode;
  /** "lg": the dashboard bento tile — 40px figure, larger chip and padding. */
  size?: "default" | "lg";
}) {
  const lg = size === "lg";
  const colors = TONES[tone];
  return (
    <Card size={lg ? "default" : "sm"} className={cn(lg && "h-full")}>
      <CardContent className={cn("flex flex-col", lg ? "gap-3" : "gap-2")}>
        <div className="flex items-center gap-2.5">
          {Icon && (
            <span className={cn("flex shrink-0 items-center justify-center", lg ? "size-10 rounded-xl" : "size-8 rounded-[10px]", colors.badge)}>
              <Icon className={lg ? "size-[18px]" : "size-4"} />
            </span>
          )}
          <p className="truncate text-xs text-ink-muted">{label}</p>
          {info && <MetricInfo metric={info} className="-ml-1" />}
          {metric && <AnalyticsMetricInfo metric={metric} label={label} className="-ml-1" />}
          {explain}
        </div>
        {value === null ? (
          <>
            <p className="line-clamp-2 text-sm font-medium text-ink-secondary">
              {unavailableReason ?? "Données indisponibles"}
            </p>
            {hint && <p className="text-xs text-ink-muted">{hint}</p>}
          </>
        ) : (
          <>
            <p
              className={cn(
                "truncate font-semibold tracking-tight text-ink tabular-nums",
                lg ? "text-[32px] leading-none sm:text-[40px]" : "text-[28px] leading-tight"
              )}
            >
              {value}
            </p>
            {(hint || trend) && (
              <div className="flex items-center gap-1.5 text-xs text-ink-muted">
                {trend && <TrendBadge trend={trend} />}
                {hint && <span className={lg ? "line-clamp-2" : "truncate"}>{hint}</span>}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * "Trend KPI" (Phase 3 pattern E): a small directional pill (arrow + %)
 * instead of plain colored text — communicates "up/down/flat" through
 * shape as well as color, so it still reads correctly at a glance and for
 * a color-blind viewer. Shared by KpiCard and HighlightKpi so a trend
 * never looks different depending which tile it lands on.
 */
export function TrendBadge({ trend }: { trend: { direction: "up" | "down" | "flat"; label: string } }) {
  const TrendIcon = TREND_ICON[trend.direction];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums",
        trend.direction === "up" && "bg-pill-green text-pill-green-fg",
        trend.direction === "down" && "bg-pill-red text-pill-red-fg",
        trend.direction === "flat" && "bg-pill-neutral text-pill-neutral-fg"
      )}
    >
      <TrendIcon className="size-3" />
      {trend.label}
    </span>
  );
}
