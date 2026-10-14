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
  /** « ⓘ » next to the label (e.g. <DashboardMetricInfo/>). */
  explain?: React.ReactNode;
}

const TONE_ICON_CLASS: Record<NonNullable<BreakdownRow["tone"]>, string> = {
  default: "bg-pill-blue text-pill-blue-fg",
  success: "bg-pill-green text-pill-green-fg",
  warning: "bg-pill-yellow text-pill-yellow-fg",
  danger: "bg-pill-red text-pill-red-fg",
};

const TONE_VALUE_CLASS: Record<NonNullable<BreakdownRow["tone"]>, string> = {
  default: "text-ink",
  success: "text-ink",
  warning: "text-pill-yellow-fg",
  danger: "text-pill-red-fg",
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
    <StaggerUl className={cn("divide-y divide-hairline", className)}>
      {rows.map((r) => (
        <StaggerItem key={r.key} as="li" className="flex items-center justify-between gap-3 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {r.icon && (
              <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", TONE_ICON_CLASS[r.tone ?? "default"])}>
                <r.icon className="size-4" />
              </span>
            )}
            <div className="min-w-0">
              {r.explain ? (
                <p className="flex min-w-0 items-center gap-0.5 text-sm font-medium">
                  <span className="truncate">{r.label}</span>
                  {r.explain}
                </p>
              ) : (
                <p className="truncate text-sm font-medium">{r.label}</p>
              )}
              {r.meta && <p className="truncate text-xs text-ink-muted">{r.meta}</p>}
            </div>
          </div>
          <span className={cn("shrink-0 text-base font-semibold tabular-nums", TONE_VALUE_CLASS[r.tone ?? "default"])}>{r.value}</span>
        </StaggerItem>
      ))}
    </StaggerUl>
  );
}
