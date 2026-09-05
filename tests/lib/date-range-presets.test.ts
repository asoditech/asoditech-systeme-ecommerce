import { describe, expect, it } from "vitest";
import { resolveDateRangePreset, DATE_RANGE_PRESET_LABELS } from "@/lib/date-range-presets";

const NOW = new Date(2026, 5, 15, 14, 30, 0); // 15 June 2026, 14:30 — a Monday

describe("resolveDateRangePreset", () => {
  it("today: the whole current day", () => {
    const { from, to } = resolveDateRangePreset("today", NOW);
    expect(from).toEqual(new Date(2026, 5, 15, 0, 0, 0));
    expect(to).toEqual(new Date(2026, 5, 15, 23, 59, 59, 999));
  });

  it("yesterday: the whole previous day, not touching today", () => {
    const { from, to } = resolveDateRangePreset("yesterday", NOW);
    expect(from).toEqual(new Date(2026, 5, 14, 0, 0, 0));
    expect(to).toEqual(new Date(2026, 5, 14, 23, 59, 59, 999));
  });

  it("7d: 6 days back through today (7 whole days inclusive)", () => {
    const { from, to } = resolveDateRangePreset("7d", NOW);
    expect(from).toEqual(new Date(2026, 5, 9, 0, 0, 0));
    expect(to).toEqual(new Date(2026, 5, 15, 23, 59, 59, 999));
  });

  it("30d and 90d follow the same inclusive-window shape", () => {
    expect(resolveDateRangePreset("30d", NOW).from).toEqual(new Date(2026, 4, 17, 0, 0, 0));
    expect(resolveDateRangePreset("90d", NOW).from).toEqual(new Date(2026, 2, 18, 0, 0, 0));
  });

  it("this-month: the 1st through the end of today", () => {
    const { from, to } = resolveDateRangePreset("this-month", NOW);
    expect(from).toEqual(new Date(2026, 5, 1));
    expect(to).toEqual(new Date(2026, 5, 15, 23, 59, 59, 999));
  });

  it("last-month: the entire previous calendar month", () => {
    const { from, to } = resolveDateRangePreset("last-month", NOW);
    expect(from).toEqual(new Date(2026, 4, 1));
    expect(to).toEqual(new Date(2026, 4, 31, 23, 59, 59, 999));
  });

  it("all: unbounded on both ends", () => {
    expect(resolveDateRangePreset("all", NOW)).toEqual({});
  });

  it("custom: echoes back the given from/to as whole days", () => {
    const { from, to } = resolveDateRangePreset("custom", NOW, { from: "2026-03-01", to: "2026-03-31" });
    expect(from).toEqual(new Date("2026-03-01T00:00:00"));
    expect(to).toEqual(new Date("2026-03-31T23:59:59.999"));
  });

  it("custom: leaves a side unbounded when not supplied", () => {
    expect(resolveDateRangePreset("custom", NOW, { from: "2026-03-01" })).toEqual({
      from: new Date("2026-03-01T00:00:00"),
      to: undefined,
    });
    expect(resolveDateRangePreset("custom", NOW, {})).toEqual({ from: undefined, to: undefined });
  });

  it("custom: an invalid date string resolves to unbounded rather than an Invalid Date", () => {
    const { from } = resolveDateRangePreset("custom", NOW, { from: "not-a-date" });
    expect(from).toBeUndefined();
  });

  it("every preset has a label, including custom", () => {
    for (const key of Object.keys(DATE_RANGE_PRESET_LABELS)) {
      expect(DATE_RANGE_PRESET_LABELS[key as keyof typeof DATE_RANGE_PRESET_LABELS]).toBeTruthy();
    }
  });
});
