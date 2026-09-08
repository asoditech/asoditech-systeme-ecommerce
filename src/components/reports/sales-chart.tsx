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
import type { SalesSeriesPoint } from "@/lib/queries/reports/sales";

/** Revenue bars + an orders line over the report's series (daily for a
 * short window, monthly for a long one). Rendered above the compact
 * series table on the sales report. */
export function SalesChart({ data }: { data: SalesSeriesPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={16} />
        <YAxis
          yAxisId="rev"
          tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
          tick={{ fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={40}
        />
        <YAxis yAxisId="ord" orientation="right" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={28} allowDecimals={false} />
        <Tooltip
          formatter={(value: number, name) =>
            name === "revenue" ? [formatCurrency(value), "CA"] : [value, "Commandes"]
          }
          contentStyle={{ fontSize: 12, borderRadius: 8 }}
        />
        <Bar yAxisId="rev" dataKey="revenue" fill="var(--color-primary)" radius={[3, 3, 0, 0]} maxBarSize={48} />
        <Line yAxisId="ord" type="monotone" dataKey="orders" stroke="var(--color-violet-500, #8b5cf6)" strokeWidth={2} dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
