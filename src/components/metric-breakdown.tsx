import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { StaggerUl, StaggerItem } from "@/components/motion/stagger-list";

export interface BreakdownRow {
  key: string;
  label: string;
  value: string;
  /** Small supporting text under the label, e.g. a count or a rate. */
  meta?: string;
  icon?: LucideIcon;
  tone?: "default" | "success" | "warning" | "danger";
}

const TONE_ICON_CLASS: Record<NonNullable<BreakdownRow["tone"]>, string> = {
  default: "bg-muted text-muted-foreground",
  success: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warning: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  danger: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
};

const TONE_VALUE_CLASS: Record<NonNullable<BreakdownRow["tone"]>, string> = {
  default: "text-foreground",
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  danger: "text-rose-600 dark:text-rose-400",
};

/**
 * A compact "total, then how it splits" list — Phase 2 UI refinement. Each
 * row is icon + label + optional meta on the left, a value (tone-coloured)
 * on the right — the same visual grammar Jumbo's channel-spend list uses,
 * adapted to ASODITECH's restrained palette (no random per-platform
 * colours). Used for status pipelines (confirmed/delivered/returned),
 * category breakdowns, anything that is "one whole split into named
 * parts" rather than a ranking (see `RankedMetricList` for that instead).
 */
export function MetricBreakdown({ rows, className }: { rows: BreakdownRow[]; className?: string }) {
  return (
    <StaggerUl className={cn("divide-y", className)}>
      {rows.map((r) => (
        <StaggerItem key={r.key} as="li" className="flex items-center justify-between gap-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            {r.icon && (
              <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", TONE_ICON_CLASS[r.tone ?? "default"])}>
                <r.icon className="size-4" />
              </span>
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{r.label}</p>
              {r.meta && <p className="truncate text-[11px] text-muted-foreground">{r.meta}</p>}
            </div>
          </div>
          <span className={cn("shrink-0 text-sm font-semibold tabular-nums", TONE_VALUE_CLASS[r.tone ?? "default"])}>{r.value}</span>
        </StaggerItem>
      ))}
    </StaggerUl>
  );
}
