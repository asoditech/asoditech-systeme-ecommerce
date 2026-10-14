"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatCurrency } from "@/lib/format";
import { CHART_AXIS_PROPS, CHART_BAR_RADIUS, CHART_BAR_RADIUS_DENSE, CHART_GRID_PROPS, chartTooltipProps } from "@/lib/design/chart";

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
  const fmt = (v: number) => (currency ? formatCurrency(v) : String(v));
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-ink-secondary">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-full" style={{ background: s.color }} aria-hidden="true" />
            {s.label}
          </span>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }} barGap={1} barCategoryGap="12%">
          <CartesianGrid {...CHART_GRID_PROPS} />
          <XAxis dataKey="label" {...CHART_AXIS_PROPS} minTickGap={16} />
          <YAxis
            {...CHART_AXIS_PROPS}
            width={40}
            allowDecimals={currency}
            tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
          />
          <Tooltip
            {...chartTooltipProps()}
            formatter={(value: number, name) => [fmt(value), series.find((s) => s.key === name)?.label ?? name]}
          />
          {series.map((s) => (
            <Bar key={s.key} dataKey={s.key} fill={s.color} radius={series.length > 1 || data.length > 16 ? CHART_BAR_RADIUS_DENSE : CHART_BAR_RADIUS} maxBarSize={28} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
