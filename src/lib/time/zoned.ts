/**
 * Calendar maths in the BUSINESS time zone (BusinessSettings.timezone,
 * « Africa/Casablanca » by default) instead of the server's — on Vercel the
 * server runs in UTC, so « hier » computed with `new Date(y, m, d)` started
 * an hour late for a Moroccan shop. Pure and client-safe: plain `Intl`, no
 * dependency. Every function takes the zone explicitly; `undefined` keeps
 * the historical server-local behaviour (pure unit tests, callers not yet
 * migrated).
 *
 * Days are half-open in spirit: a day's end is the next day's start minus
 * 1 ms, so a day is 23 h or 25 h long across an offset change (Morocco
 * moves to UTC+0 for Ramadan) and never skips or double-counts an instant.
 */

export const DEFAULT_BUSINESS_TIME_ZONE = "Africa/Casablanca";

export interface ZonedParts {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    formatterFor(value);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock reading of `instant` in `timeZone` (server-local when undefined). */
export function zonedParts(instant: Date, timeZone?: string): ZonedParts {
  if (!timeZone) {
    return {
      year: instant.getFullYear(),
      month: instant.getMonth() + 1,
      day: instant.getDate(),
      hour: instant.getHours(),
      minute: instant.getMinutes(),
      second: instant.getSeconds(),
    };
  }
  const parts: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(instant)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second };
}

/** Milliseconds the zone is ahead of UTC at `instant`. */
function offsetAt(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant at which the zone's wall clock reads the given time.
 * Out-of-range fields normalize like `Date.UTC` (day 0 = last day of the
 * previous month, day 32 = next month…), which makes "add N days / months"
 * plain arithmetic on the fields.
 */
export function zonedInstant(
  timeZone: string | undefined,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0
): Date {
  if (!timeZone) return new Date(year, month - 1, day, hour, minute, second, ms);
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  // Two passes: the offset at the first guess may differ from the offset at
  // the answer when an offset change falls in between.
  let guess = wall - offsetAt(new Date(wall), timeZone);
  guess = wall - offsetAt(new Date(guess), timeZone);
  return new Date(guess);
}

export function startOfZonedDay(instant: Date, timeZone?: string): Date {
  const p = zonedParts(instant, timeZone);
  return zonedInstant(timeZone, p.year, p.month, p.day);
}

export function endOfZonedDay(instant: Date, timeZone?: string): Date {
  const p = zonedParts(instant, timeZone);
  return new Date(zonedInstant(timeZone, p.year, p.month, p.day + 1).getTime() - 1);
}

/** Start of the day `days` calendar days after `instant`'s day (negative = before). */
export function zonedDayStartOffset(instant: Date, days: number, timeZone?: string): Date {
  const p = zonedParts(instant, timeZone);
  return zonedInstant(timeZone, p.year, p.month, p.day + days);
}

/** « YYYY-MM-DD » of `instant` in the zone. */
export function zonedDayKey(instant: Date, timeZone?: string): string {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A « YYYY-MM-DD » filter value → the start (or, with `endOfDay`, the last
 * millisecond) of that day in the zone. Anything else — including an
 * impossible date like 2026-02-31 — is `undefined`, never an Invalid Date.
 */
export function parseZonedDay(value: string | undefined | null, timeZone: string | undefined, endOfDay = false): Date | undefined {
  const m = value ? DAY.exec(value) : null;
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return undefined;
  return endOfDay ? new Date(zonedInstant(timeZone, y, mo, d + 1).getTime() - 1) : zonedInstant(timeZone, y, mo, d);
}

/** First and last « YYYY-MM-DD » of `now`'s month in the zone — for a default « ce mois » filter. */
export function zonedMonthDayKeys(now: Date, timeZone?: string): { first: string; last: string } {
  const p = zonedParts(now, timeZone);
  const mm = String(p.month).padStart(2, "0");
  const lastDay = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
  return { first: `${p.year}-${mm}-01`, last: `${p.year}-${mm}-${String(lastDay).padStart(2, "0")}` };
}
