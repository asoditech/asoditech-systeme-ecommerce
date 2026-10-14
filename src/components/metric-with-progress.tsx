import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

export interface ProgressSegment {
  label: string;
  value: number;
  className: string;
}

/**
 * A KPI whose value is better understood as a share of a whole than as a
 * bare number — Phase 2 UI refinement ("visually communicate total/
 * available/reserved stock via progress/segmented bars, not just large
 * numbers"). Two modes:
 *  - `segments`: a multi-colour bar (e.g. reserved vs available out of
 *    total stock), each segment's share is `segment.value / total`, with a
 *    small legend underneath giving the exact numbers.
 *  - `percent` (0-100): a single-colour bar for a simple "used of a limit"
 *    reading (e.g. a usage/quota metric).
 * Never computes the numbers itself — the caller passes whatever the
 * existing canonical query already returned.
 */
export function MetricWithProgress({
  label,
  value,
  hint,
  icon: Icon,
  segments,
  percent,
  barClassName,
  explain,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: LucideIcon;
  segments?: ProgressSegment[];
  percent?: number;
  barClassName?: string;
  /** « ⓘ » next to the label (e.g. <DashboardMetricInfo/>). */
  explain?: React.ReactNode;
}) {
  const total = segments?.reduce((sum, s) => sum + s.value, 0) ?? 0;

  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-2.5">
        {/* Same header grammar as KpiCard (badge beside the label, 2xl
            value) so a progress tile sitting next to a KPI tile reads as
            the same system, not a different component. */}
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            {Icon && (
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-pill-peach text-pill-peach-fg">
                <Icon className="size-3.5" />
              </span>
            )}
            <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
            {explain}
          </div>
          <p className="truncate text-2xl font-semibold tracking-tight text-ink tabular-nums">{value}</p>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>

        {segments && segments.length > 0 && (
          <div className="space-y-2">
            <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-chart-track">
              {segments.map((s) =>
                s.value > 0 ? (
                  <div
                    key={s.label}
                    className={cn("h-full first:rounded-l-full last:rounded-r-full", s.className)}
                    style={{ width: `${total > 0 ? (s.value / total) * 100 : 0}%` }}
                  />
                ) : null
              )}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {segments.map((s) => (
                <span key={s.label} className="flex items-center gap-1 text-xs text-muted-foreground">
                  <span className={cn("size-1.5 shrink-0 rounded-full", s.className)} />
                  {s.label} <span className="font-medium text-foreground">{s.value}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {percent !== undefined && (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-chart-track">
            <div
              className={cn("h-full rounded-full bg-brand", barClassName)}
              style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
