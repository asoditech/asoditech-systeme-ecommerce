"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatCurrency } from "@/lib/format";

/**
 * Grouped bars over a period series (confirmation, delivery outcomes,
 * commissions). One chart per question, no decoration: the legend names
 * each series and the tooltip gives the exact value.
 */
export function SeriesChart({
  data,
  series,
  currency = false,
}: {
  data: Record<string, string | number>[];
  series: { key: string; label: string; color: string }[];
  currency?: boolean;
}) {
  const tick = { fontSize: 11, fill: "var(--color-muted-foreground)" };
  const fmt = (v: number) => (currency ? formatCurrency(v) : String(v));
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: s.color }} aria-hidden="true" />
            {s.label}
          </span>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
          <XAxis dataKey="label" tick={tick} tickLine={false} axisLine={false} minTickGap={16} />
          <YAxis
            tick={tick}
            tickLine={false}
            axisLine={false}
            width={40}
            allowDecimals={currency}
            tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
          />
          <Tooltip
            formatter={(value: number, name) => [fmt(value), series.find((s) => s.key === name)?.label ?? name]}
            cursor={{ fill: "var(--color-muted)", opacity: 0.6 }}
            contentStyle={{
              fontSize: 12,
              borderRadius: 10,
              border: "1px solid var(--color-border)",
              background: "var(--color-popover)",
              boxShadow: "var(--shadow-popover)",
            }}
          />
          {series.map((s) => (
            <Bar key={s.key} dataKey={s.key} fill={s.color} radius={[3, 3, 0, 0]} maxBarSize={28} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
