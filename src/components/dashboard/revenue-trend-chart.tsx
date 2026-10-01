"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatCurrency } from "@/lib/format";

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
 * Gross-revenue chart for the dashboard — Phase 3 (Premium Visual SaaS
 * Transformation, section 8): replaces the earlier hand-rolled div/CSS bar
 * chart with the same recharts gradient-area treatment already established
 * in src/components/analytics/revenue-trend-chart.tsx, so the app has ONE
 * chart language, not two. Same data, same numbers — only the rendering
 * changed. The "chart + insight" pairing (total for the range, peak month)
 * is computed here from the exact array the page already fetched — never a
 * second query, never an invented figure.
 */
export function RevenueTrendChart({ data }: { data: Bucket[] }) {
  const total = data.reduce((sum, d) => sum + d.revenue, 0);
  const peak = data.reduce((best, d) => (d.revenue > best.revenue ? d : best), data[0] ?? { key: "", label: "", revenue: 0 });
  const hasData = total > 0;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="text-2xl font-bold tracking-tight tabular-nums">{formatCurrency(total)}</p>
        {hasData && (
          <p className="text-xs text-muted-foreground">
            Pic : <span className="font-medium text-foreground capitalize">{peak.label}</span> ({shortAmount(peak.revenue)} MAD)
          </p>
        )}
      </div>
      {hasData ? (
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
            <defs>
              <linearGradient id="dashboardRevenueFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-primary)" stopOpacity={0.28} />
                <stop offset="95%" stopColor="var(--color-primary)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={16} className="capitalize" />
            <YAxis tickFormatter={(v: number) => shortAmount(v)} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={36} />
            <Tooltip
              formatter={(value: number) => formatCurrency(value)}
              labelFormatter={(label: string) => label}
              contentStyle={{ fontSize: 12, borderRadius: 8, textTransform: "capitalize" }}
            />
            <Area
              type="monotone"
              dataKey="revenue"
              stroke="var(--color-primary)"
              fill="url(#dashboardRevenueFill)"
              strokeWidth={2}
              activeDot={{ r: 4 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <div className="flex h-[240px] items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
          Aucun chiffre d&apos;affaires sur cette période.
        </div>
      )}
    </div>
  );
}
