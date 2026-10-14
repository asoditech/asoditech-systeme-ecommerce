import type { CSSProperties } from "react";

/**
 * Soft UI chart language (redesign/soft-ui) — the ONE place recharts charts
 * take their colours and chrome from. Every value is a CSS variable defined
 * in src/app/globals.css (light + dark), so a chart follows the theme
 * without re-rendering and a palette change happens there only.
 *
 * Rules: rounded bars (radius 8), pastel bars with ONE highlighted bar,
 * minimal horizontal grid, smooth (monotone) lines, dark tooltip chip,
 * donuts with rounded caps.
 */
export const CHART_COLORS = {
  series: ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"],
  bar: "var(--chart-bar)",
  barHover: "var(--chart-bar-hover)",
  highlight: "var(--chart-highlight)",
  line: "var(--chart-1)",
  area: "var(--chart-area)",
  grid: "var(--chart-grid)",
  axis: "var(--chart-axis)",
  cursor: "var(--chart-cursor)",
  track: "var(--chart-track)",
  /** Meaning colours for multi-series charts (a series named by what it counts). */
  brand: "var(--chart-1)",
  neutral: "var(--chart-2)",
  positive: "var(--chart-3)",
  negative: "var(--danger)",
  attention: "var(--chart-5)",
  secondary: "var(--chart-4)",
} as const;

/** Bar corner radius (px) — all four corners, Soft UI pill-like bars. */
export const CHART_BAR_RADIUS: [number, number, number, number] = [8, 8, 8, 8];

/** Narrow grouped bars (several series × many days): a radius wider than the
 * bar would collapse it into a hairline, so only the top is rounded, less. */
export const CHART_BAR_RADIUS_DENSE: [number, number, number, number] = [3, 3, 0, 0];

/** `<CartesianGrid {...CHART_GRID_PROPS} />` — horizontal hairlines only. */
export const CHART_GRID_PROPS = {
  vertical: false,
  stroke: CHART_COLORS.grid,
  strokeDasharray: "0",
} as const;

/** `<XAxis {...CHART_AXIS_PROPS} />` / `<YAxis …/>` — no lines, muted 11px ticks. */
export const CHART_AXIS_PROPS = {
  tickLine: false,
  axisLine: false,
  tick: { fontSize: 11, fill: CHART_COLORS.axis },
} as const;

const tooltipContent: CSSProperties = {
  background: "var(--chart-tooltip-bg)",
  border: "none",
  borderRadius: 12,
  boxShadow: "0 12px 32px -8px rgb(0 0 0 / 0.3)",
  padding: "8px 12px",
  fontSize: 12,
  color: "var(--chart-tooltip-fg)",
};

/** `<Tooltip {...chartTooltipProps()} />` — the dark tooltip chip. */
export function chartTooltipProps(cursor: "bar" | "line" = "bar") {
  return {
    contentStyle: tooltipContent,
    labelStyle: { color: "var(--chart-tooltip-muted)", marginBottom: 2, fontSize: 11, textTransform: "capitalize" as const },
    itemStyle: { color: "var(--chart-tooltip-fg)", padding: 0, fontWeight: 600 },
    cursor: cursor === "bar" ? { fill: CHART_COLORS.cursor, radius: 8 } : { stroke: CHART_COLORS.grid, strokeWidth: 1 },
    separator: " ",
  };
}

/**
 * The same palette as Tailwind background classes, for CSS bar lists
 * (`BreakdownBarList`, `FunnelBars`) that are not recharts charts.
 */
export const CHART_BAR_CLASSES = {
  brand: "bg-chart-1",
  neutral: "bg-chart-2",
  positive: "bg-chart-3",
  negative: "bg-danger",
  attention: "bg-chart-5",
  secondary: "bg-chart-4",
  muted: "bg-ink-faint",
  /** Categorical series, in order (channels, sources…). */
  series: ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5", "bg-danger", "bg-ink-faint", "bg-chart-bar"],
} as const;
