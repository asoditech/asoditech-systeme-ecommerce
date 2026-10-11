import { describe, expect, it, vi } from "vitest";

// Pure: exportFilterWhere only BUILDS a where clause — the database client is
// stubbed so nothing here connects anywhere.
vi.mock("@/lib/prisma", () => ({ prisma: {}, prismaBase: {} }));

import { exportFilterWhere } from "@/lib/catalog/export/load";

type Range = { createdAt: { gte?: Date; lte?: Date } };
const ranges = (where: ReturnType<typeof exportFilterWhere>) =>
  ((where.AND as object[] | undefined) ?? []).filter((c): c is Range => "createdAt" in c).map((c) => c.createdAt);
const inside = (instant: Date, where: ReturnType<typeof exportFilterWhere>) =>
  ranges(where).every((r) => (!r.gte || instant >= r.gte) && (!r.lte || instant <= r.lte));

/**
 * The product export's « créé du / au » filter is whole days of the business
 * time zone (Africa/Casablanca, UTC+1 outside Ramadan) — not the server's
 * UTC. A product created at 23:30 UTC on the 9th was created at 00:30 on the
 * 10th in Casablanca.
 */
describe("product export — created-date filter in the business time zone", () => {
  const TZ = "Africa/Casablanca";
  const day10 = exportFilterWhere({ createdFrom: "2026-10-10", createdTo: "2026-10-10", status: "all", source: "all" }, TZ);

  it("23:30 UTC the evening before is INSIDE the Casablanca day", () => {
    expect(inside(new Date("2026-10-09T23:30:00Z"), day10)).toBe(true);
  });

  it("22:30 UTC the evening before (23:30 local on the 9th) is outside; 22:59 UTC on the 10th (23:59 local) is inside", () => {
    expect(inside(new Date("2026-10-09T22:30:00Z"), day10)).toBe(false);
    expect(inside(new Date("2026-10-10T22:59:00Z"), day10)).toBe(true);
    expect(inside(new Date("2026-10-10T23:00:00Z"), day10)).toBe(false); // 00:00 on the 11th local
  });

  it("the bounds are the local midnight and the last millisecond of the day", () => {
    expect(ranges(day10)).toEqual([
      { gte: new Date("2026-10-09T23:00:00.000Z") },
      { lte: new Date("2026-10-10T22:59:59.999Z") },
    ]);
  });

  it("a malformed or impossible day adds no bound (never an Invalid Date)", () => {
    expect(ranges(exportFilterWhere({ createdFrom: "2026-02-31", createdTo: "10/10/2026" }, TZ))).toEqual([]);
  });
});
