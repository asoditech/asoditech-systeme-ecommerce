import type { LucideIcon } from "lucide-react";
import { ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { TONES, type Tone } from "@/lib/design/tone";

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
}: {
  label: string;
  value: string | null;
  icon?: LucideIcon;
  hint?: string;
  trend?: { direction: "up" | "down" | "flat"; label: string };
  unavailableReason?: string;
  tone?: KpiTone;
}) {
  const colors = TONES[tone];
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          {Icon && (
            <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-md", colors.badge)}>
              <Icon className="size-3.5" />
            </span>
          )}
          <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
        </div>
        {value === null ? (
          <>
            <p className="line-clamp-2 text-sm font-medium text-muted-foreground">
              {unavailableReason ?? "Données indisponibles"}
            </p>
            {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
          </>
        ) : (
          <>
            <p className="truncate text-2xl font-bold tracking-tight tabular-nums">{value}</p>
            {(hint || trend) && (
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                {trend && <TrendBadge trend={trend} />}
                {hint && <span className="truncate">{hint}</span>}
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
        "inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-[10.5px] font-semibold",
        trend.direction === "up" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        trend.direction === "down" && "bg-destructive/10 text-destructive",
        trend.direction === "flat" && "bg-muted text-muted-foreground"
      )}
    >
      <TrendIcon className="size-2.5" />
      {trend.label}
    </span>
  );
}
