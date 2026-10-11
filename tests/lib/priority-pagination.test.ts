import { describe, expect, it, vi } from "vitest";
import { paginateWithPriority } from "@/lib/priority-pagination";

/**
 * Exact-match-first pagination (src/lib/priority-pagination.ts), against an
 * in-memory "table" — no database. The `where` here is a predicate; the
 * fake findMany applies the caller's order (index = newest first).
 */

type Row = { id: number; exact: boolean };
type Where = (r: Row) => boolean;

function table(n: number, exactIds: number[]): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: i, exact: exactIds.includes(i) }));
}

function run(rows: Row[], skip: number, take: number, withPriority = true) {
  const findMany = vi.fn(async (w: Where, s: number, t: number) => rows.filter(w).slice(s, s + t));
  const count = vi.fn(async (w: Where) => rows.filter(w).length);
  return {
    findMany,
    result: paginateWithPriority<Where, Row>({
      where: () => true,
      priority: withPriority ? { exact: (r) => r.exact, rest: (r) => !r.exact } : null,
      skip,
      take,
      and: (a, b) => (r) => a(r) && b(r),
      count,
      findMany,
    }),
  };
}

describe("paginateWithPriority", () => {
  it("puts every priority row first, then the rest, each in the caller's order", async () => {
    const rows = table(10, [7, 3]);
    const { result } = run(rows, 0, 10);
    expect((await result).rows.map((r) => r.id)).toEqual([3, 7, 0, 1, 2, 4, 5, 6, 8, 9]);
    expect((await result).total).toBe(10);
  });

  it("is exact across pages: concatenated pages = priority ++ rest, no duplicate, no gap", async () => {
    const rows = table(23, [20, 4, 15, 22]);
    const expected = [4, 15, 20, 22, ...rows.filter((r) => !r.exact).map((r) => r.id)];
    for (const size of [1, 2, 3, 4, 5, 7, 30]) {
      const seen: number[] = [];
      for (let skip = 0; skip < rows.length; skip += size) {
        const page = await run(rows, skip, size).result;
        expect(page.total).toBe(23);
        expect(page.rows.length).toBe(Math.min(size, 23 - skip));
        seen.push(...page.rows.map((r) => r.id));
      }
      expect(seen, `page size ${size}`).toEqual(expected);
    }
  });

  it("a priority row on a LATER natural page still comes first on page 1 (ranked before truncation)", async () => {
    const rows = table(100, [99]);
    const page1 = await run(rows, 0, 30).result;
    expect(page1.rows[0].id).toBe(99);
    expect(page1.rows).toHaveLength(30);
  });

  it("reads at most two bounded page-sized windows, never the whole set", async () => {
    const rows = table(1000, [500, 501]);
    const { findMany, result } = run(rows, 0, 30);
    await result;
    expect(findMany).toHaveBeenCalledTimes(2);
    for (const call of findMany.mock.calls) expect(call[2]).toBeLessThanOrEqual(30);
  });

  it("with no priority it is plain pagination (one read)", async () => {
    const rows = table(5, [4]);
    const { findMany, result } = run(rows, 1, 2, false);
    expect((await result).rows.map((r) => r.id)).toEqual([1, 2]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("past the priority segment only the rest segment is read", async () => {
    const rows = table(10, [0, 1]);
    const { findMany, result } = run(rows, 4, 3);
    expect((await result).rows.map((r) => r.id)).toEqual([4, 5, 6]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
