import { resolveDateRangePreset, DATE_RANGE_PRESET_LABELS, type DateRangePreset } from "@/lib/date-range-presets";
import { previousPeriodOfSameLength, type PeriodRange } from "@/lib/queries/finance";

/**
 * Analytics period resolution (docs/adr/0051). Reuses the app's existing
 * preset maths (`resolveDateRangePreset` — server-local days, the same
 * convention as /livraison and every /rapports page); no new timezone
 * architecture. Both ends inclusive. Anything unparseable falls back to the
 * last 30 days rather than letting an invalid date reach Prisma.
 */

export const ANALYTICS_PERIODS = ["today", "yesterday", "7d", "30d", "this-month", "last-month"] as const;
export type AnalyticsPeriodKey = (typeof ANALYTICS_PERIODS)[number] | "custom";

export const ANALYTICS_PERIOD_LABELS: Record<AnalyticsPeriodKey, string> = {
  today: DATE_RANGE_PRESET_LABELS.today,
  yesterday: DATE_RANGE_PRESET_LABELS.yesterday,
  "7d": DATE_RANGE_PRESET_LABELS["7d"],
  "30d": DATE_RANGE_PRESET_LABELS["30d"],
  "this-month": DATE_RANGE_PRESET_LABELS["this-month"],
  "last-month": DATE_RANGE_PRESET_LABELS["last-month"],
  custom: DATE_RANGE_PRESET_LABELS.custom,
};

export interface AnalyticsPeriod {
  key: AnalyticsPeriodKey;
  label: string;
  range: PeriodRange;
  /** Same length, immediately before — for the (guarded) comparisons. */
  previous: PeriodRange;
  /** Echoed into links / the filter form / the CSV export. */
  params: { period?: string; from?: string; to?: string };
  granularity: "day" | "month";
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function resolveAnalyticsPeriod(input: { period?: string; from?: string; to?: string }, now: Date = new Date()): AnalyticsPeriod {
  if (input.from && input.to && DAY.test(input.from) && DAY.test(input.to)) {
    const r = resolveDateRangePreset("custom", now, { from: input.from, to: input.to });
    if (r.from && r.to && r.from <= r.to) {
      return build("custom", `${input.from} → ${input.to}`, { from: r.from, to: r.to }, { from: input.from, to: input.to });
    }
  }
  const key = (ANALYTICS_PERIODS as readonly string[]).includes(input.period ?? "") ? (input.period as AnalyticsPeriodKey) : "30d";
  const r = resolveDateRangePreset(key as DateRangePreset, now);
  return build(key, ANALYTICS_PERIOD_LABELS[key], { from: r.from!, to: r.to! }, { period: key });
}

function build(key: AnalyticsPeriodKey, label: string, range: PeriodRange, params: AnalyticsPeriod["params"]): AnalyticsPeriod {
  const spanDays = (range.to.getTime() - range.from.getTime()) / 86_400_000;
  return { key, label, range, previous: previousPeriodOfSameLength(range), params, granularity: spanDays > 62 ? "month" : "day" };
}

const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

/** Bucket key of a date for the period's granularity (server-local day, like the sales report). */
export function bucketKey(d: Date, granularity: "day" | "month"): string {
  const day = d.toLocaleDateString("en-CA");
  return granularity === "month" ? day.slice(0, 7) : day;
}

export function bucketLabel(key: string, granularity: "day" | "month"): string {
  const [y, m, d] = key.split("-");
  return granularity === "month" ? `${MONTHS[Number(m) - 1]} ${y}` : `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

/** Every bucket key of the range, in order — so an empty day is a 0, not a gap. */
export function bucketKeys(range: PeriodRange, granularity: "day" | "month"): string[] {
  const keys: string[] = [];
  const cursor = new Date(range.from);
  cursor.setHours(0, 0, 0, 0);
  if (granularity === "month") cursor.setDate(1);
  while (cursor <= range.to) {
    keys.push(bucketKey(cursor, granularity));
    if (granularity === "month") cursor.setMonth(cursor.getMonth() + 1);
    else cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

/**
 * A period-over-period change, shown ONLY when it means something: both
 * populations hold at least `minPopulation` events (default 20). Below that a
 * "+100 %" is noise (2 orders vs 1), so no comparison is displayed at all.
 */
export function meaningfulDelta(
  current: number | null,
  previous: number | null,
  population: { current: number; previous: number },
  minPopulation = 20
): number | null {
  if (current === null || previous === null || previous === 0) return null;
  if (population.current < minPopulation || population.previous < minPopulation) return null;
  return Number((((current - previous) / Math.abs(previous)) * 100).toFixed(1));
}
