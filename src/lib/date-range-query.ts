import type { DateRangePreset } from "@/lib/date-range-presets";

/**
 * Pure rules behind the shared date-range controls (DateRangeFields /
 * DateRangeFilter). Dates are the `YYYY-MM-DD` day strings every page
 * already reads from its URL — nothing here interprets a timezone: each page
 * keeps resolving the day in the business zone exactly as before.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A `YYYY-MM-DD` value a date input can show; anything else = "" (empty field). */
export function dayParam(value: string | null | undefined): string {
  return value && DAY.test(value) ? value : "";
}

/**
 * The `min` / `max` links between the two inputs so the browser's picker
 * never offers « Au » before « Du » (and vice versa). Purely a UI guard: the
 * pages still validate on the server.
 */
export function linkedDayBounds(from: string, to: string): { fromMax?: string; toMin?: string } {
  return { fromMax: dayParam(to) || undefined, toMin: dayParam(from) || undefined };
}

/**
 * The query string of the preset + custom-range filter (`range`, then the
 * page's own date param names). Same output the two former components built,
 * so existing URLs and server parsing are unchanged:
 *  - custom → `range=custom` + the non-empty days;
 *  - another preset → `range=<preset>` unless it is the page default;
 *  - kept params (page sizes, other filters) first, empty ones dropped.
 */
export function buildDateRangeQuery(input: {
  range: DateRangePreset;
  from: string;
  to: string;
  defaultRange: DateRangePreset;
  fromParam?: string;
  toParam?: string;
  keep?: Record<string, string | undefined>;
}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(input.keep ?? {})) if (v) params.set(k, v);
  if (input.range === "custom") {
    if (dayParam(input.from)) params.set(input.fromParam ?? "dateFrom", input.from);
    if (dayParam(input.to)) params.set(input.toParam ?? "dateTo", input.to);
    params.set("range", "custom");
  } else if (input.range !== input.defaultRange) {
    params.set("range", input.range);
  }
  return params.toString();
}
