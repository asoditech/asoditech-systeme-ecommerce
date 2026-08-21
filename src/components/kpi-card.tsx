import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

/**
 * A dashboard/analytics KPI tile. `value` is `null` when the metric genuinely
 * cannot be computed (missing data, no integration connected) — renders
 * "Non calculable" rather than fabricating a number. See the project's Data
 * Integrity Principle.
 */
export function KpiCard({
  label,
  value,
  icon: Icon,
  hint,
  trend,
  unavailableReason,
}: {
  label: string;
  value: string | null;
  icon?: LucideIcon;
  hint?: string;
  trend?: { direction: "up" | "down" | "flat"; label: string };
  unavailableReason?: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 pt-5">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{label}</p>
          {Icon && <Icon className="size-4 text-muted-foreground" />}
        </div>
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
      </CardContent>
    </Card>
  );
}
