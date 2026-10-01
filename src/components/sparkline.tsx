"use client";

import { Area, AreaChart, ResponsiveContainer } from "recharts";

/**
 * Phase 4 (Complete Product UI/UX Visual Redesign) — a minimal trend line
 * with no axes/grid/tooltip, for embedding inside a hero or stat surface
 * (the "sparkline" motif every premium SaaS dashboard uses next to a
 * headline number). `id` must be unique per instance on a page — recharts
 * gradient `<defs>` are real DOM ids, and two sparklines sharing one would
 * silently render each other's fill. Real data only, same convention as
 * every other chart in the app: the caller passes numbers it already
 * fetched, this component never computes or invents a trend.
 */
export function Sparkline({
  id,
  data,
  color = "currentColor",
  height = 40,
}: {
  id: string;
  data: { value: number }[];
  color?: string;
  height?: number;
}) {
  if (data.length < 2) return null;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.4} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="value" stroke={color} strokeWidth={1.75} fill={`url(#${id})`} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
