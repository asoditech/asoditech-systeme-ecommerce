"use client";

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatCurrency } from "@/lib/format";
import { CHART_AXIS_PROPS, CHART_BAR_RADIUS, CHART_COLORS, CHART_GRID_PROPS, chartTooltipProps } from "@/lib/design/chart";

interface Bucket {
  key: string;
  label: string;
  revenue: number;
}

function shortAmount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(Math.round(n));
}

/**
 * Gross-revenue chart for the dashboard. Soft UI (redesign/soft-ui): rounded
 * pastel bars with ONE highlighted bar — the peak bucket, the same « Pic »
 * named above the chart — on hairline horizontal grid lines, dark tooltip
 * chip; colours from src/lib/design/chart.ts. Same data, same numbers — only
 * the rendering changed. The "chart + insight" pairing (total for the range,
 * peak month) is computed here from the exact array the page already fetched
 * — never a second query, never an invented figure.
 */
export function RevenueTrendChart({ data }: { data: Bucket[] }) {
  const total = data.reduce((sum, d) => sum + d.revenue, 0);
  const peak = data.reduce((best, d) => (d.revenue > best.revenue ? d : best), data[0] ?? { key: "", label: "", revenue: 0 });
  const hasData = total > 0;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="text-[32px] leading-tight font-semibold tracking-tight text-ink tabular-nums">{formatCurrency(total)}</p>
        {hasData && (
          <p className="flex items-center gap-1.5 text-xs text-ink-muted">
            <span aria-hidden="true" className="size-2 rounded-full bg-chart-highlight" />
            Pic : <span className="font-medium text-ink capitalize">{peak.label}</span> ({shortAmount(peak.revenue)} MAD)
          </p>
        )}
      </div>
      {hasData ? (
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }} barCategoryGap="22%">
            <CartesianGrid {...CHART_GRID_PROPS} />
            <XAxis dataKey="label" {...CHART_AXIS_PROPS} minTickGap={8} className="capitalize" />
            <YAxis tickFormatter={(v: number) => shortAmount(v)} {...CHART_AXIS_PROPS} width={36} />
            <Tooltip
              {...chartTooltipProps("bar")}
              formatter={(value: number) => [formatCurrency(value), ""]}
              labelFormatter={(label: string) => label}
            />
            <Bar dataKey="revenue" radius={CHART_BAR_RADIUS} maxBarSize={40} isAnimationActive={false}>
              {data.map((d) => (
                <Cell key={d.key} fill={d.key === peak.key ? CHART_COLORS.highlight : CHART_COLORS.bar} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <div className="flex h-[260px] items-center justify-center rounded-tile border border-dashed border-field-border-hover text-sm text-ink-muted">
          Aucun chiffre d&apos;affaires sur cette période.
        </div>
      )}
    </div>
  );
}
