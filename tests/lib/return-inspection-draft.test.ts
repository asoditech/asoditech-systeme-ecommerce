import { describe, expect, it } from "vitest";
import {
  draftToEntries,
  draftTotals,
  matchScannedUnit,
  registerUnit,
  setLineQuantity,
  type InspectionDraftLine,
} from "@/lib/returns/inspection-draft";
import { entriesToReturnLines, inspectReturnReceptionSchema, receiveReturnParcelSchema } from "@/lib/validation/return-receiving";

/** P3 inspection draft (pure) + input schemas. */

const lines: InspectionDraftLine[] = [
  { orderItemId: "a", label: "Sac", productId: "p1", variationId: null, remaining: 2, sellable: 0, damaged: 0 },
  { orderItemId: "b", label: "Robe — M", productId: "p2", variationId: "v-m", remaining: 1, sellable: 0, damaged: 0 },
];

describe("scan → explicit condition", () => {
  it("a scan only matches its line: no quantity changes until a condition is chosen", () => {
    const m = matchScannedUnit(lines, { productId: "p1", variationId: null, label: "Sac" });
    expect(m).toEqual({ ok: true, pending: { orderItemId: "a", label: "Sac" } });
    expect(draftTotals(lines)).toEqual({ sellable: 0, damaged: 0, notReceived: 3 });
  });

  it("the chosen condition is the one registered — sellable or damaged", () => {
    const s = registerUnit(lines, "a", "SELLABLE");
    const d = registerUnit(lines, "a", "DAMAGED");
    expect(s.ok && s.lines[0]).toMatchObject({ sellable: 1, damaged: 0 });
    expect(d.ok && d.lines[0]).toMatchObject({ sellable: 0, damaged: 1 });
  });

  it("wrong variant, foreign article and over-scan are refused", () => {
    expect(matchScannedUnit(lines, { productId: "p2", variationId: "v-l", label: "Robe — L" }).ok).toBe(false);
    expect(matchScannedUnit(lines, { productId: "zz", variationId: null, label: "Autre" }).ok).toBe(false);
    const full = registerUnit(lines, "b", "DAMAGED");
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(registerUnit(full.lines, "b", "SELLABLE")).toMatchObject({ ok: false });
    expect(matchScannedUnit(full.lines, { productId: "p2", variationId: "v-m", label: "Robe — M" }).ok).toBe(false);
  });

  it("typed quantities are clamped to what remains for that line", () => {
    const t = setLineQuantity(setLineQuantity(lines, "a", "SELLABLE", "5"), "a", "DAMAGED", "3");
    expect(t[0]).toMatchObject({ sellable: 2, damaged: 0 });
    expect(setLineQuantity(lines, "a", "SELLABLE", "-4")[0].sellable).toBe(0);
  });

  it("only non-zero (line, condition) pairs are submitted; unreceived units are simply not sent", () => {
    const t = setLineQuantity(setLineQuantity(lines, "a", "SELLABLE", 1), "a", "DAMAGED", 1);
    expect(draftToEntries(t)).toEqual([
      { orderItemId: "a", condition: "SELLABLE", quantity: 1 },
      { orderItemId: "a", condition: "DAMAGED", quantity: 1 },
    ]);
    expect(draftTotals(t)).toEqual({ sellable: 1, damaged: 1, notReceived: 1 });
    expect(draftToEntries(lines)).toEqual([]);
  });
});

describe("input schemas", () => {
  it("an inspection entry without a condition (or an unknown one) is invalid — never a sellable default", () => {
    const base = { receptionId: "r", idempotencyKey: "k" };
    expect(inspectReturnReceptionSchema.safeParse({ ...base, entries: [{ orderItemId: "a", quantity: 1 }] }).success).toBe(false);
    expect(inspectReturnReceptionSchema.safeParse({ ...base, entries: [{ orderItemId: "a", quantity: 1, condition: "OK" }] }).success).toBe(false);
    expect(inspectReturnReceptionSchema.safeParse({ ...base, entries: [] }).success).toBe(false);
    expect(inspectReturnReceptionSchema.safeParse({ ...base, entries: [{ orderItemId: "a", quantity: 1, condition: "DAMAGED" }] }).success).toBe(true);
  });

  it("extra client-supplied ids are rejected (strict)", () => {
    expect(receiveReturnParcelSchema.safeParse({ shipmentId: "s", tenantId: "t" }).success).toBe(false);
    expect(receiveReturnParcelSchema.safeParse({ shipmentId: "s", warehouseId: "w" }).success).toBe(false);
    expect(receiveReturnParcelSchema.safeParse({ shipmentId: "s" }).success).toBe(true);
  });

  it("entries map to sellable / damaged quantities without mixing them", () => {
    expect(
      entriesToReturnLines([
        { orderItemId: "a", condition: "SELLABLE", quantity: 2 },
        { orderItemId: "a", condition: "DAMAGED", quantity: 1 },
      ])
    ).toEqual([
      { orderItemId: "a", quantitySellable: 2, quantityDamaged: 0 },
      { orderItemId: "a", quantitySellable: 0, quantityDamaged: 1 },
    ]);
  });
});
