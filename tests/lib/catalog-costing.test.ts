import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { computeUpdatedCost } from "@/lib/catalog/costing";

/**
 * Product costing math (Phase 3 — Product Costing & Profitability input).
 * Pure function, no DB — see src/lib/catalog/costing.ts's own doc comment
 * for the exact contract. Every assertion compares against a `Prisma.Decimal`
 * built the same way the module itself builds one, so a passing test can
 * never hide silent floating-point corruption creeping back in.
 */

const d = (n: number | string) => new Prisma.Decimal(n);

describe("computeUpdatedCost — MANUAL", () => {
  it("returns the existing cost unchanged", () => {
    const result = computeUpdatedCost({
      method: "MANUAL",
      existingOnHand: 10,
      existingCost: d("42.50"),
      receivedQty: 5,
      receivedUnitCost: d("99.00"),
    });
    expect(result?.toString()).toBe("42.5");
  });

  it("returns null when there was no existing cost — never fabricates one", () => {
    const result = computeUpdatedCost({
      method: "MANUAL",
      existingOnHand: 10,
      existingCost: null,
      receivedQty: 5,
      receivedUnitCost: d("99.00"),
    });
    expect(result).toBeNull();
  });
});

describe("computeUpdatedCost — LAST_COST", () => {
  it("becomes the received unit cost, regardless of existing state", () => {
    const result = computeUpdatedCost({
      method: "LAST_COST",
      existingOnHand: 10,
      existingCost: d("42.50"),
      receivedQty: 5,
      receivedUnitCost: d("99.00"),
    });
    expect(result?.toString()).toBe("99");
  });

  it("becomes the received unit cost even with zero existing stock and no existing cost", () => {
    const result = computeUpdatedCost({
      method: "LAST_COST",
      existingOnHand: 0,
      existingCost: null,
      receivedQty: 20,
      receivedUnitCost: d("15.75"),
    });
    expect(result?.toString()).toBe("15.75");
  });
});

describe("computeUpdatedCost — WEIGHTED_AVERAGE", () => {
  it("blends existing and received stock proportionally to quantity", () => {
    // 10 units @ 100 + 10 units @ 200 -> 150 average
    const result = computeUpdatedCost({
      method: "WEIGHTED_AVERAGE",
      existingOnHand: 10,
      existingCost: d(100),
      receivedQty: 10,
      receivedUnitCost: d(200),
    });
    expect(result?.toString()).toBe("150");
  });

  it("weights unevenly matched quantities correctly", () => {
    // 100 units @ 10 + 10 units @ 120 -> (1000 + 1200) / 110 = 20
    const result = computeUpdatedCost({
      method: "WEIGHTED_AVERAGE",
      existingOnHand: 100,
      existingCost: d(10),
      receivedQty: 10,
      receivedUnitCost: d(120),
    });
    expect(result?.toString()).toBe("20");
  });

  it("existingOnHand = 0 -> resulting cost becomes the received unit cost", () => {
    const result = computeUpdatedCost({
      method: "WEIGHTED_AVERAGE",
      existingOnHand: 0,
      existingCost: d(500), // irrelevant — nothing to weight against
      receivedQty: 7,
      receivedUnitCost: d("33.33"),
    });
    expect(result?.toString()).toBe("33.33");
  });

  it("negative existingOnHand (defensive) is treated the same as zero", () => {
    const result = computeUpdatedCost({
      method: "WEIGHTED_AVERAGE",
      existingOnHand: -3,
      existingCost: d(500),
      receivedQty: 7,
      receivedUnitCost: d("33.33"),
    });
    expect(result?.toString()).toBe("33.33");
  });

  it("existing cost is null with positive existing stock -> never fabricates a blended value, uses the received cost", () => {
    const result = computeUpdatedCost({
      method: "WEIGHTED_AVERAGE",
      existingOnHand: 100,
      existingCost: null,
      receivedQty: 10,
      receivedUnitCost: d(50),
    });
    expect(result?.toString()).toBe("50");
  });

  it("keeps decimal precision — no floating-point corruption", () => {
    // 3 units @ 10.10 + 7 units @ 10.20 -> (30.30 + 71.40) / 10 = 10.17
    const result = computeUpdatedCost({
      method: "WEIGHTED_AVERAGE",
      existingOnHand: 3,
      existingCost: d("10.10"),
      receivedQty: 7,
      receivedUnitCost: d("10.20"),
    });
    expect(result?.toString()).toBe("10.17");
  });

  it("does not round prematurely — a repeating-decimal average keeps full precision", () => {
    // 1 unit @ 10 + 2 units @ 20 -> 50 / 3 = 16.6666...
    const result = computeUpdatedCost({
      method: "WEIGHTED_AVERAGE",
      existingOnHand: 1,
      existingCost: d(10),
      receivedQty: 2,
      receivedUnitCost: d(20),
    });
    expect(result?.toString()).toBe("16.666666666666666667");
  });
});

describe("computeUpdatedCost — defensive input validation", () => {
  it("throws when receivedQty is zero or negative", () => {
    expect(() =>
      computeUpdatedCost({ method: "LAST_COST", existingOnHand: 0, existingCost: null, receivedQty: 0, receivedUnitCost: d(10) })
    ).toThrow();
    expect(() =>
      computeUpdatedCost({ method: "LAST_COST", existingOnHand: 0, existingCost: null, receivedQty: -1, receivedUnitCost: d(10) })
    ).toThrow();
  });

  it("throws when receivedUnitCost is negative", () => {
    expect(() =>
      computeUpdatedCost({ method: "LAST_COST", existingOnHand: 0, existingCost: null, receivedQty: 5, receivedUnitCost: d(-1) })
    ).toThrow();
  });

  it("accepts a zero received unit cost (a free/promotional reception)", () => {
    const result = computeUpdatedCost({
      method: "LAST_COST",
      existingOnHand: 0,
      existingCost: null,
      receivedQty: 5,
      receivedUnitCost: d(0),
    });
    expect(result?.toString()).toBe("0");
  });
});
