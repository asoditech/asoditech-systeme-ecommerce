"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCurrency } from "@/lib/format";
import { CHART_AXIS_PROPS, CHART_BAR_RADIUS, CHART_BAR_RADIUS_DENSE, CHART_COLORS, CHART_GRID_PROPS, chartTooltipProps } from "@/lib/design/chart";
import type { SalesSeriesPoint } from "@/lib/queries/reports/sales";

/** Revenue bars + an orders line over the report's series (daily for a
 * short window, monthly for a long one). Rendered above the compact
 * series table on the sales report. */
export function SalesChart({ data }: { data: SalesSeriesPoint[] }) {
  return (
    <div>
      {/* Two series on two axes — the legend is what makes the purple line
          readable as "orders" (right axis) rather than a second revenue. */}
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-ink-secondary">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-chart-bar" aria-hidden="true" />
          Chiffre d&apos;affaires (axe gauche)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded-full bg-chart-4" aria-hidden="true" />
          Commandes (axe droit)
        </span>
      </div>
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
        <CartesianGrid {...CHART_GRID_PROPS} />
        <XAxis dataKey="label" {...CHART_AXIS_PROPS} minTickGap={16} />
        <YAxis
          yAxisId="rev"
          tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
          {...CHART_AXIS_PROPS}
          width={40}
        />
        <YAxis yAxisId="ord" orientation="right" {...CHART_AXIS_PROPS} width={28} allowDecimals={false} />
        <Tooltip
          {...chartTooltipProps()}
          formatter={(value: number, name) =>
            name === "revenue" ? [formatCurrency(value), "CA"] : [value, "Commandes"]
          }
        />
        <Bar yAxisId="rev" dataKey="revenue" fill={CHART_COLORS.bar} radius={data.length > 16 ? CHART_BAR_RADIUS_DENSE : CHART_BAR_RADIUS} maxBarSize={48} />
        <Line yAxisId="ord" type="monotone" dataKey="orders" stroke={CHART_COLORS.series[3]} strokeWidth={2} dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
    </div>
  );
}
