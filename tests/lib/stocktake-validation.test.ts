import { describe, expect, it } from "vitest";
import {
  createStocktakeSessionSchema,
  updateStocktakeCountsSchema,
  finalizeStocktakeSessionSchema,
  cancelStocktakeSessionSchema,
  canTransitionStocktakeStatus,
  STOCKTAKE_STATUS_TRANSITIONS,
} from "@/lib/validation/stocktake";

describe("createStocktakeSessionSchema", () => {
  it("accepts a warehouseId with optional notes", () => {
    expect(createStocktakeSessionSchema.safeParse({ warehouseId: "wh_1" }).success).toBe(true);
    expect(createStocktakeSessionSchema.safeParse({ warehouseId: "wh_1", notes: "  comptage annuel " }).success).toBe(true);
    const parsed = createStocktakeSessionSchema.parse({ warehouseId: "wh_1", notes: "  x  " });
    expect(parsed.notes).toBe("x"); // trimmed
  });

  it("rejects a missing or empty warehouseId", () => {
    expect(createStocktakeSessionSchema.safeParse({}).success).toBe(false);
    expect(createStocktakeSessionSchema.safeParse({ warehouseId: "" }).success).toBe(false);
    expect(createStocktakeSessionSchema.safeParse({ warehouseId: 123 }).success).toBe(false);
  });
});

describe("updateStocktakeCountsSchema", () => {
  const base = (counts: unknown) => updateStocktakeCountsSchema.safeParse({ id: "st_1", counts });

  it("accepts positive and zero counted quantities", () => {
    expect(base([{ lineId: "l1", countedQuantity: 5 }]).success).toBe(true);
    expect(base([{ lineId: "l1", countedQuantity: 0 }]).success).toBe(true);
    expect(base([
      { lineId: "l1", countedQuantity: 3 },
      { lineId: "l2", countedQuantity: 0 },
    ]).success).toBe(true);
  });

  it("accepts an explicit null (clear the count) without coercing it to 0", () => {
    const r = base([{ lineId: "l1", countedQuantity: null }]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.counts[0].countedQuantity).toBeNull();
  });

  it("rejects negative and non-integer counts", () => {
    expect(base([{ lineId: "l1", countedQuantity: -1 }]).success).toBe(false);
    expect(base([{ lineId: "l1", countedQuantity: 1.5 }]).success).toBe(false);
    expect(base([{ lineId: "l1", countedQuantity: "abc" }]).success).toBe(false);
    // missing countedQuantity is malformed (must be a number or explicit null)
    expect(base([{ lineId: "l1" }]).success).toBe(false);
  });

  it("rejects malformed line IDs and empty payloads", () => {
    expect(base([{ lineId: "", countedQuantity: 1 }]).success).toBe(false);
    expect(base([{ lineId: 42, countedQuantity: 1 }]).success).toBe(false);
    expect(base([]).success).toBe(false);
    expect(updateStocktakeCountsSchema.safeParse({ id: "", counts: [{ lineId: "l1", countedQuantity: 1 }] }).success).toBe(false);
  });
});

describe("finalize / cancel schemas", () => {
  it("require a non-empty id", () => {
    expect(finalizeStocktakeSessionSchema.safeParse({ id: "st_1" }).success).toBe(true);
    expect(finalizeStocktakeSessionSchema.safeParse({ id: "" }).success).toBe(false);
    expect(cancelStocktakeSessionSchema.safeParse({ id: "st_1" }).success).toBe(true);
    expect(cancelStocktakeSessionSchema.safeParse({}).success).toBe(false);
  });
});

describe("stocktake status transitions", () => {
  it("allows only EN_COURS -> CLOTURE and EN_COURS -> ANNULE", () => {
    expect(canTransitionStocktakeStatus("EN_COURS", "CLOTURE")).toBe(true);
    expect(canTransitionStocktakeStatus("EN_COURS", "ANNULE")).toBe(true);
  });

  it("treats CLOTURE and ANNULE as terminal", () => {
    expect(STOCKTAKE_STATUS_TRANSITIONS.CLOTURE).toEqual([]);
    expect(STOCKTAKE_STATUS_TRANSITIONS.ANNULE).toEqual([]);
    expect(canTransitionStocktakeStatus("CLOTURE", "EN_COURS")).toBe(false);
    expect(canTransitionStocktakeStatus("CLOTURE", "ANNULE")).toBe(false);
    expect(canTransitionStocktakeStatus("ANNULE", "EN_COURS")).toBe(false);
    expect(canTransitionStocktakeStatus("ANNULE", "CLOTURE")).toBe(false);
  });

  it("rejects a no-op transition to the same status", () => {
    expect(canTransitionStocktakeStatus("EN_COURS", "EN_COURS")).toBe(false);
  });
});
