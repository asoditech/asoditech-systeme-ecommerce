import "server-only";

import {
  currentMonthRange,
  currentQuarterRange,
  currentYearRange,
  previousPeriodOfSameLength,
  type PeriodRange,
} from "@/lib/queries/finance";
import { getBusinessTimeZone } from "@/lib/time/business-zone";
import { parseZonedDay } from "@/lib/time/zoned";

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

/**
 * Days and calendar periods are the BUSINESS time zone's when `timeZone` is
 * given (src/lib/time/zoned.ts) — use resolveTenantReportRange from a
 * request; `undefined` keeps server-local days (pure tests).
 */
export function resolveReportRange(
  params: {
    period?: string;
    from?: string;
    to?: string;
  },
  timeZone?: string,
  now: Date = new Date()
): ResolvedReportRange {
  const from = parseZonedDay(params.from, timeZone);
  const to = parseZonedDay(params.to, timeZone, true);
  if (from && to && from <= to) {
    const range = { from, to };
    return {
      range,
      previous: previousPeriodOfSameLength(range),
      key: "custom",
      label: `${params.from} → ${params.to}`,
      params: { from: params.from, to: params.to },
    };
  }

  if (params.period === "quarter") {
    const range = currentQuarterRange(timeZone, now);
    return { range, previous: previousPeriodOfSameLength(range), key: "quarter", label: "Ce trimestre", params: { period: "quarter" } };
  }
  if (params.period === "year") {
    const range = currentYearRange(timeZone, now);
    return { range, previous: previousPeriodOfSameLength(range), key: "year", label: "Cette année", params: { period: "year" } };
  }
  const range = currentMonthRange(timeZone, now);
  return { range, previous: previousPeriodOfSameLength(range), key: "month", label: "Ce mois", params: { period: "month" } };
}

/** resolveReportRange in the current tenant's business time zone. */
export async function resolveTenantReportRange(params: { period?: string; from?: string; to?: string }): Promise<ResolvedReportRange> {
  return resolveReportRange(params, await getBusinessTimeZone());
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
