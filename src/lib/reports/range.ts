import "server-only";

import {
  currentMonthRange,
  currentQuarterRange,
  currentYearRange,
  previousPeriodOfSameLength,
  type PeriodRange,
} from "@/lib/queries/finance";

/**
 * Shared date-range resolution for every /rapports page and its CSV
 * export route, so a report page and "Exporter" always cover the exact
 * same window. Accepts either a named preset (`period=month|quarter|year`)
 * or an explicit `from`/`to` (YYYY-MM-DD, inclusive) — an explicit range
 * wins. Anything unparseable falls back to the current month rather than
 * letting `new Date("…")` reach Prisma.
 */

export type ReportPeriodKey = "month" | "quarter" | "year" | "custom";

export interface ResolvedReportRange {
  range: PeriodRange;
  previous: PeriodRange;
  key: ReportPeriodKey;
  label: string;
  /** Echoed back into export links / the filter form so they stay in sync. */
  params: { period?: ReportPeriodKey; from?: string; to?: string };
}

function parseDay(value: string | undefined, endOfDay = false): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const d = new Date(endOfDay ? `${value}T23:59:59.999` : `${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function toDay(d: Date): string {
  return d.toLocaleDateString("en-CA");
}

export function resolveReportRange(params: {
  period?: string;
  from?: string;
  to?: string;
}): ResolvedReportRange {
  const from = parseDay(params.from);
  const to = parseDay(params.to, true);
  if (from && to && from <= to) {
    const range = { from, to };
    return {
      range,
      previous: previousPeriodOfSameLength(range),
      key: "custom",
      label: `${toDay(from)} → ${toDay(to)}`,
      params: { from: params.from, to: params.to },
    };
  }

  if (params.period === "quarter") {
    const range = currentQuarterRange();
    return { range, previous: previousPeriodOfSameLength(range), key: "quarter", label: "Ce trimestre", params: { period: "quarter" } };
  }
  if (params.period === "year") {
    const range = currentYearRange();
    return { range, previous: previousPeriodOfSameLength(range), key: "year", label: "Cette année", params: { period: "year" } };
  }
  const range = currentMonthRange();
  return { range, previous: previousPeriodOfSameLength(range), key: "month", label: "Ce mois", params: { period: "month" } };
}

/** Percentage change current vs previous, one decimal — null when the
 * previous value is zero (no meaningful ratio) or either side is null. */
export function deltaPct(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return Number((((current - previous) / Math.abs(previous)) * 100).toFixed(1));
}

/** The range's params as a clean `?a=b` query string (no `undefined`
 * entries) — for building the CSV-export link that mirrors the page. */
export function rangeQuery(
  resolved: ResolvedReportRange,
  extra: Record<string, string | undefined> = {}
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...resolved.params, ...extra })) {
    if (v) sp.set(k, v);
  }
  return sp.toString();
}
