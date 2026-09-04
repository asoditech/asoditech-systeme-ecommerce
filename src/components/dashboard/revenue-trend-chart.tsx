import { formatCurrency } from "@/lib/format";

interface Bucket {
  key: string;
  label: string;
  revenue: number;
}

const CHART_HEIGHT = 128;

function shortAmount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(Math.round(n));
}

/**
 * Gross-revenue bar chart for the dashboard. Server component, plain
 * div/CSS — no client JS, no charting library.
 *
 * Bars use an explicit pixel height computed here, never a CSS
 * percentage: a percentage height only resolves against a parent whose
 * *own* height is itself explicit, and the natural way to lay this out
 * (a `flex-col` column pinned to the bottom of its row with
 * `items-end`) leaves that parent auto-sized — the bars silently
 * collapsed to nothing while the labels around them still rendered
 * (exactly what showed up as "numbers and month names, no chart").
 */
export function RevenueTrendChart({ data }: { data: Bucket[] }) {
  const max = Math.max(1, ...data.map((d) => d.revenue));
  const currentKey = data[data.length - 1]?.key;
  const dense = data.length > 15;

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{shortAmount(max)} MAD</span>
        <span className="tabular-nums">0</span>
      </div>
      <div className="relative border-b" style={{ height: CHART_HEIGHT }}>
        {/* reference line at the max value */}
        <div className="absolute inset-x-0 top-0 border-t border-dashed border-border" aria-hidden />
        <div className="flex h-full items-end gap-1.5 overflow-x-auto pb-px">
          {data.map((d) => {
            const barPx = Math.max(2, Math.round((d.revenue / max) * CHART_HEIGHT));
            const isCurrent = d.key === currentKey;
            return (
              <div
                key={d.key}
                className="group flex h-full min-w-[6px] flex-1 flex-col items-center justify-end"
                title={`${d.label} : ${formatCurrency(d.revenue)}`}
              >
                <span
                  className={`mb-1 whitespace-nowrap text-[10px] tabular-nums text-muted-foreground transition-opacity ${
                    dense ? "opacity-0 group-hover:opacity-100" : ""
                  }`}
                >
                  {shortAmount(d.revenue)}
                </span>
                <div
                  className={`w-full rounded-t-sm transition-colors ${
                    isCurrent ? "bg-primary" : "bg-primary/30 group-hover:bg-primary/60"
                  }`}
                  style={{ height: barPx }}
                />
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-1.5 flex gap-1.5 overflow-x-auto">
        {data.map((d) => (
          <span
            key={d.key}
            className={`flex-1 min-w-[6px] text-center text-[10px] capitalize ${
              d.key === currentKey ? "font-medium text-foreground" : "text-muted-foreground"
            } ${dense && data.indexOf(d) % Math.ceil(data.length / 12) !== 0 ? "invisible" : ""}`}
          >
            {d.label}
          </span>
        ))}
      </div>
    </div>
  );
}
