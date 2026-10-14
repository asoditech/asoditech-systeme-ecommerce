/**
 * Phase 3 — Premium Visual SaaS Transformation.
 *
 * The ONE tone→color mapping every "meaningful color" surface in the app
 * shares (KpiCard, HighlightKpi, MetricWithProgress, ProductMetricRow, …) —
 * pulled out of `kpi-card.tsx` (where it used to live, page-scoped) so a
 * new pattern component never invents its own slightly-different palette.
 * Every value is derived from the existing brand/semantic tokens in
 * globals.css (oklch primary orange + the standard Tailwind emerald/amber/
 * cyan/violet/rose scale already used app-wide) — no new colors introduced.
 *
 * `tone` is a MEANING, not a decoration: primary = brand/primary action or
 * headline business metric, success = positive/completed, warning =
 * needs-attention, info = neutral/informational, violet = financial/
 * commission-adjacent, danger = destructive/critical. Keep call sites
 * choosing tone by what the number MEANS, never by "which color looks nice
 * here" (docs request, section 4).
 */

// Soft UI (redesign/soft-ui): `badge` (the small icon chip) uses the pastel
// pill tokens of globals.css. The unused bar/text/surface/ring entries were
// removed (dead styles, Step 6); charts take their colours from chart.ts.
export const TONES = {
  primary: {
    badge: "bg-pill-peach text-pill-peach-fg",
  },
  success: {
    badge: "bg-pill-green text-pill-green-fg",
  },
  warning: {
    badge: "bg-pill-yellow text-pill-yellow-fg",
  },
  info: {
    badge: "bg-pill-blue text-pill-blue-fg",
  },
  violet: {
    badge: "bg-pill-purple text-pill-purple-fg",
  },
  danger: {
    badge: "bg-pill-red text-pill-red-fg",
  },
} as const;

export type Tone = keyof typeof TONES;
