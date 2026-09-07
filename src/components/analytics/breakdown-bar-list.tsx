import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A small "distribution" list — label, count, share of the total, and a
 * proportional horizontal bar — for a simple category→count breakdown
 * (order status, order channel, …). Deliberately plain CSS, no charting
 * library: this is a handful of rows, not a chart. Caller supplies each
 * row's bar color so this stays a dumb presentational component; sorting
 * is the caller's responsibility too (both current callers already sort
 * their query result descending).
 */
export function BreakdownBarList({
  items,
}: {
  items: { key: string; label: ReactNode; count: number; barColor: string }[];
}) {
  const total = items.reduce((sum, item) => sum + item.count, 0);
  const max = Math.max(1, ...items.map((item) => item.count));

  return (
    <div className="space-y-3">
      {items.map((item) => {
        const share = total > 0 ? Math.round((item.count / total) * 100) : 0;
        return (
          <div key={item.key}>
            <div className="mb-1 flex items-center justify-between gap-3">
              <div className="min-w-0">{item.label}</div>
              <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                {item.count}
                <span className="ml-1 text-xs">({share} %)</span>
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full", item.barColor)}
                style={{ width: `${(item.count / max) * 100}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
