import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUSINESS_TIME_ZONE,
  endOfZonedDay,
  isValidTimeZone,
  parseZonedDay,
  startOfZonedDay,
  zonedDayKey,
  zonedInstant,
  zonedMonthDayKeys,
} from "@/lib/time/zoned";
import { resolveDateRangePreset } from "@/lib/date-range-presets";
import { currentDayRange, currentMonthRange, currentQuarterRange, yesterdayRange } from "@/lib/queries/finance";
import { bucketKey, bucketKeys, resolveAnalyticsPeriod } from "@/lib/analytics/period";
import { resolveReportRange } from "@/lib/reports/range";

/**
 * S2 — days are the BUSINESS time zone's (Africa/Casablanca by default), not
 * the server's (UTC on Vercel). Morocco is UTC+1, and UTC+0 during Ramadan:
 * in 2026 it moves back at 2026-02-15 03:00 → 02:00 (a 25 h day) and forward
 * at 2026-03-22 02:00 → 03:00 (a 23 h day).
 */
const CASA = DEFAULT_BUSINESS_TIME_ZONE;
const iso = (d: Date | undefined) => d?.toISOString();
const HOUR = 3_600_000;

describe("zoned calendar primitives", () => {
  it("the default business zone is Africa/Casablanca and is valid; garbage is not", () => {
    expect(CASA).toBe("Africa/Casablanca");
    expect(isValidTimeZone(CASA)).toBe(true);
    expect(isValidTimeZone("Europe/Paris")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
  });

  it("00:30 in Casablanca (23:30 UTC the day before) belongs to the Moroccan day", () => {
    const instant = new Date("2026-10-09T23:30:00Z");
    expect(zonedDayKey(instant, CASA)).toBe("2026-10-10");
    expect(iso(startOfZonedDay(instant, CASA))).toBe("2026-10-09T23:00:00.000Z");
    expect(iso(endOfZonedDay(instant, CASA))).toBe("2026-10-10T22:59:59.999Z");
    // The historical server-local (UTC) reading put it on the 9th.
    expect(zonedDayKey(instant, "UTC")).toBe("2026-10-09");
  });

  it("23:59:59.999 and 00:00:00.000 Casablanca fall on consecutive days, with no gap", () => {
    const end9 = parseZonedDay("2026-10-09", CASA, true)!;
    const start10 = parseZonedDay("2026-10-10", CASA)!;
    expect(start10.getTime() - end9.getTime()).toBe(1);
    expect(zonedDayKey(end9, CASA)).toBe("2026-10-09");
    expect(zonedDayKey(start10, CASA)).toBe("2026-10-10");
  });

  it("parseZonedDay accepts only real YYYY-MM-DD days", () => {
    expect(iso(parseZonedDay("2026-10-10", CASA))).toBe("2026-10-09T23:00:00.000Z");
    expect(iso(parseZonedDay("2026-10-10", CASA, true))).toBe("2026-10-10T22:59:59.999Z");
    for (const bad of ["", "all", "2026-02-31", "2026-13-01", "10/10/2026", "2026-10-10T00:00", undefined, null]) {
      expect(parseZonedDay(bad as string, CASA), String(bad)).toBeUndefined();
    }
  });

  it("Ramadan offset changes: the Moroccan day is 25 h then 23 h long, never skipping an instant", () => {
    const len = (day: string) => parseZonedDay(day, CASA, true)!.getTime() + 1 - parseZonedDay(day, CASA)!.getTime();
    expect(len("2026-02-14")).toBe(24 * HOUR);
    expect(len("2026-02-15")).toBe(25 * HOUR);
    expect(len("2026-03-22")).toBe(23 * HOUR);
    expect(iso(parseZonedDay("2026-03-01", CASA))).toBe("2026-03-01T00:00:00.000Z"); // UTC+0 during Ramadan
    expect(iso(parseZonedDay("2026-03-23", CASA))).toBe("2026-03-22T23:00:00.000Z"); // back to UTC+1
  });

  it("European DST days are 23 h / 25 h too (zone-generic)", () => {
    const len = (day: string) => parseZonedDay(day, "Europe/Paris", true)!.getTime() + 1 - parseZonedDay(day, "Europe/Paris")!.getTime();
    expect(len("2026-03-29")).toBe(23 * HOUR);
    expect(len("2026-10-25")).toBe(25 * HOUR);
  });

  it("zonedInstant normalizes overflowing fields like Date.UTC", () => {
    expect(iso(zonedInstant(CASA, 2026, 10, 32))).toBe(iso(zonedInstant(CASA, 2026, 11, 1)));
    expect(iso(zonedInstant(CASA, 2026, 13, 1))).toBe(iso(zonedInstant(CASA, 2027, 1, 1)));
    // 31 Jan 23:30 UTC is already 1 Feb in Casablanca (UTC+1)…
    expect(zonedMonthDayKeys(new Date("2026-01-31T23:30:00Z"), CASA)).toEqual({ first: "2026-02-01", last: "2026-02-28" });
    expect(zonedMonthDayKeys(new Date("2026-01-31T23:30:00Z"), "UTC")).toEqual({ first: "2026-01-01", last: "2026-01-31" });
    // …but 28 Feb 23:30 UTC is still 28 Feb there (UTC+0 during Ramadan).
    expect(zonedMonthDayKeys(new Date("2026-02-28T23:30:00Z"), CASA)).toEqual({ first: "2026-02-01", last: "2026-02-28" });
  });
});

describe("presets and periods in the business zone", () => {
  // 00:30 on 10 October 2026 in Casablanca.
  const NOW = new Date("2026-10-09T23:30:00Z");

  it("« Hier » at 00:30 Moroccan time is the 9th in Morocco — the server's UTC would say the 8th", () => {
    const y = resolveDateRangePreset("yesterday", NOW, undefined, CASA);
    expect([iso(y.from), iso(y.to)]).toEqual(["2026-10-08T23:00:00.000Z", "2026-10-09T22:59:59.999Z"]);
    const t = resolveDateRangePreset("today", NOW, undefined, CASA);
    expect([iso(t.from), iso(t.to)]).toEqual(["2026-10-09T23:00:00.000Z", "2026-10-10T22:59:59.999Z"]);
    expect(resolveDateRangePreset("yesterday", NOW, undefined, "UTC").from?.toISOString()).toBe("2026-10-08T00:00:00.000Z");
  });

  it("an order placed at 00:30 Moroccan time counts for today, not yesterday", () => {
    const placedAt = NOW;
    const yesterday = resolveDateRangePreset("yesterday", NOW, undefined, CASA);
    const today = resolveDateRangePreset("today", NOW, undefined, CASA);
    expect(placedAt >= yesterday.from! && placedAt <= yesterday.to!).toBe(false);
    expect(placedAt >= today.from! && placedAt <= today.to!).toBe(true);
  });

  it("7d / this-month / last-month / custom use Moroccan days", () => {
    expect(iso(resolveDateRangePreset("7d", NOW, undefined, CASA).from)).toBe("2026-10-03T23:00:00.000Z");
    expect(iso(resolveDateRangePreset("this-month", NOW, undefined, CASA).from)).toBe("2026-09-30T23:00:00.000Z");
    const last = resolveDateRangePreset("last-month", NOW, undefined, CASA);
    expect([iso(last.from), iso(last.to)]).toEqual(["2026-08-31T23:00:00.000Z", "2026-09-30T22:59:59.999Z"]);
    const custom = resolveDateRangePreset("custom", NOW, { from: "2026-10-01", to: "2026-10-02" }, CASA);
    expect([iso(custom.from), iso(custom.to)]).toEqual(["2026-09-30T23:00:00.000Z", "2026-10-02T22:59:59.999Z"]);
  });

  it("finance periods: day / yesterday / month / quarter end at their last millisecond, contiguous", () => {
    expect(iso(currentDayRange(CASA, NOW).from)).toBe("2026-10-09T23:00:00.000Z");
    expect(iso(yesterdayRange(CASA, NOW).to)).toBe("2026-10-09T22:59:59.999Z");
    const month = currentMonthRange(CASA, NOW);
    expect([iso(month.from), iso(month.to)]).toEqual(["2026-09-30T23:00:00.000Z", "2026-10-31T22:59:59.999Z"]);
    const quarter = currentQuarterRange(CASA, NOW);
    expect([iso(quarter.from), iso(quarter.to)]).toEqual(["2026-09-30T23:00:00.000Z", "2026-12-31T22:59:59.999Z"]);
  });

  it("report and analytics ranges carry the zone through custom days and buckets", () => {
    const r = resolveReportRange({ from: "2026-03-21", to: "2026-03-23" }, CASA, NOW);
    expect([iso(r.range.from), iso(r.range.to)]).toEqual(["2026-03-21T00:00:00.000Z", "2026-03-23T22:59:59.999Z"]);
    expect(r.label).toBe("2026-03-21 → 2026-03-23");

    const p = resolveAnalyticsPeriod({ from: "2026-03-21", to: "2026-03-23" }, NOW, CASA);
    expect(p.timeZone).toBe(CASA);
    expect(bucketKeys(p.range, "day", CASA)).toEqual(["2026-03-21", "2026-03-22", "2026-03-23"]);
    expect(bucketKey(new Date("2026-03-22T23:30:00Z"), "day", CASA)).toBe("2026-03-23");
    expect(bucketKeys({ from: parseZonedDay("2026-01-15", CASA)!, to: parseZonedDay("2026-03-02", CASA, true)! }, "month", CASA)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
  });
});
