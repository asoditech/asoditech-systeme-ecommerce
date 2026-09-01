import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

const TONES = {
  primary: { badge: "bg-primary/12 text-primary", bar: "bg-primary" },
  success: { badge: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", bar: "bg-emerald-500" },
  warning: { badge: "bg-amber-500/10 text-amber-600 dark:text-amber-400", bar: "bg-amber-500" },
  info: { badge: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400", bar: "bg-cyan-500" },
  violet: { badge: "bg-violet-500/10 text-violet-600 dark:text-violet-400", bar: "bg-violet-500" },
  danger: { badge: "bg-rose-500/10 text-rose-600 dark:text-rose-400", bar: "bg-rose-500" },
} as const;

export type KpiTone = keyof typeof TONES;

/**
 * A dashboard/analytics KPI tile. `value` is `null` when the metric genuinely
 * cannot be computed (missing data, no integration connected) — renders
 * "Non calculable" rather than fabricating a number. See the project's Data
 * Integrity Principle. `tone` only varies the icon badge color/accent bar —
 * purely visual, never implies a different data-integrity guarantee.
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
    <Card className="relative overflow-hidden">
      <span className={cn("absolute inset-x-0 top-0 h-0.5", colors.bar)} aria-hidden="true" />
      <CardContent className="flex items-start justify-between gap-3 pt-5">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="truncate text-sm text-muted-foreground">{label}</p>
          {value === null ? (
            <>
              <p className="text-lg font-medium text-muted-foreground">
                {unavailableReason ?? "Données indisponibles"}
              </p>
              {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
            </>
          ) : (
            <>
              <p className="text-2xl font-semibold tracking-tight">{value}</p>
              {(hint || trend) && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {trend && (
                    <span
                      className={cn(
                        "font-medium",
                        trend.direction === "up" && "text-emerald-600 dark:text-emerald-400",
                        trend.direction === "down" && "text-destructive"
                      )}
                    >
                      {trend.label}
                    </span>
                  )}
                  {hint && <span>{hint}</span>}
                </div>
              )}
            </>
          )}
        </div>
        {Icon && (
          <div className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg", colors.badge)}>
            <Icon className="size-5" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
