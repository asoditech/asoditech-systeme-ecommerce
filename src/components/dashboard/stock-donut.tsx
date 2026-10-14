"use client";

import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { CHART_COLORS } from "@/lib/design/chart";

/**
 * Dashboard « Stock physique » as a donut (Soft UI: rounded caps, pastel
 * series, the total in the middle). Same three figures the page already
 * fetched (getStockOverview) — on hand, available, reserved — nothing
 * computed here beyond the slice proportions.
 */
export function StockDonut({
  total,
  segments,
}: {
  /** The on-hand figure shown in the middle. */
  total: string;
  segments: { label: string; value: number; color: string }[];
}) {
  const slices = segments.filter((s) => s.value > 0);
  const empty = slices.length === 0;
  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:gap-6">
      <div className="relative size-40 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={empty ? [{ label: "", value: 1 }] : slices}
              dataKey="value"
              nameKey="label"
              innerRadius="72%"
              outerRadius="100%"
              startAngle={90}
              endAngle={-270}
              paddingAngle={slices.length > 1 ? 4 : 0}
              cornerRadius={slices.length > 1 ? 10 : 0}
              stroke="none"
              isAnimationActive={false}
            >
              {empty ? <Cell fill={CHART_COLORS.track} /> : slices.map((s) => <Cell key={s.label} fill={s.color} />)}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[28px] leading-none font-semibold tracking-tight text-ink tabular-nums">{total}</span>
        </div>
      </div>
      <ul className="w-full min-w-0 space-y-2.5">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2 text-ink-secondary">
              <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
              {s.label}
            </span>
            <span className="font-semibold text-ink tabular-nums">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
