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

export const TONES = {
  primary: {
    badge: "bg-primary/12 text-primary",
    bar: "bg-primary",
    text: "text-primary",
    surface: "from-primary/14 via-primary/6 to-transparent",
    ring: "ring-primary/15",
  },
  success: {
    badge: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    bar: "bg-emerald-500",
    text: "text-emerald-600 dark:text-emerald-400",
    surface: "from-emerald-500/14 via-emerald-500/5 to-transparent",
    ring: "ring-emerald-500/15",
  },
  warning: {
    badge: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    bar: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
    surface: "from-amber-500/14 via-amber-500/5 to-transparent",
    ring: "ring-amber-500/15",
  },
  info: {
    badge: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
    bar: "bg-cyan-500",
    text: "text-cyan-600 dark:text-cyan-400",
    surface: "from-cyan-500/14 via-cyan-500/5 to-transparent",
    ring: "ring-cyan-500/15",
  },
  violet: {
    badge: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    bar: "bg-violet-500",
    text: "text-violet-600 dark:text-violet-400",
    surface: "from-violet-500/14 via-violet-500/5 to-transparent",
    ring: "ring-violet-500/15",
  },
  danger: {
    badge: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
    bar: "bg-rose-500",
    text: "text-rose-600 dark:text-rose-400",
    surface: "from-rose-500/14 via-rose-500/5 to-transparent",
    ring: "ring-rose-500/15",
  },
} as const;

export type Tone = keyof typeof TONES;
