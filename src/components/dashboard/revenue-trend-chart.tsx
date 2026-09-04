import { formatCurrency } from "@/lib/format";

interface Bucket {
  key: string;
  label: string;
  revenue: number;
}

/**
 * Six-month gross-revenue bar chart for the dashboard. Server component,
 * plain SVG — no client JS, no charting library. The scale is anchored to
 * the tallest bar; a bar with no revenue still shows a hairline so an
 * empty month reads as "0", not "missing".
 */
export function RevenueTrendChart({ data }: { data: Bucket[] }) {
  const max = Math.max(1, ...data.map((d) => d.revenue));
  const currentKey = data[data.length - 1]?.key;

  return (
    <div className="flex items-end gap-3" style={{ height: 140 }}>
      {data.map((d) => {
        const pct = (d.revenue / max) * 100;
        const isCurrent = d.key === currentKey;
        return (
          <div key={d.key} className="flex flex-1 flex-col items-center gap-1.5" title={`${d.label} : ${formatCurrency(d.revenue)}`}>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {d.revenue >= 1000 ? `${Math.round(d.revenue / 1000)}k` : Math.round(d.revenue)}
            </span>
            <div className="flex w-full flex-1 items-end">
              <div
                className={`w-full rounded-t ${isCurrent ? "bg-primary" : "bg-primary/35"}`}
                style={{ height: `${Math.max(pct, 1.5)}%` }}
              />
            </div>
            <span className={`text-xs capitalize ${isCurrent ? "font-medium text-foreground" : "text-muted-foreground"}`}>
              {d.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
