import { describe, expect, it } from "vitest";
import {
  isPackingComplete,
  packingCounts,
  packingLines,
  packingResetFor,
  scanVerdict,
  shippableOrderProblem,
  shippableOrderWhere,
} from "@/lib/packing";
import { SHIPPABLE_ORDER_STATUSES } from "@/lib/delivery";

describe("packing rules (pure)", () => {
  const lines = packingLines([
    { productId: "p1", variationId: "v1", nameSnapshot: "T-shirt", skuSnapshot: "TS-N", quantity: 1, label: "T-shirt — Noir" },
    { productId: "p1", variationId: "v1", nameSnapshot: "T-shirt", skuSnapshot: "TS-N", quantity: 1, label: "T-shirt — Noir" },
    { productId: "p2", variationId: null, nameSnapshot: "Casquette", skuSnapshot: "CAP", quantity: 2 },
  ]);

  it("the same unit on two lines is one line to pack, quantities summed", () => {
    expect(lines).toEqual([
      { key: "v:v1", label: "T-shirt — Noir", sku: "TS-N", required: 2 },
      { key: "p:p2", label: "Casquette", sku: "CAP", required: 2 },
    ]);
  });

  it("verdicts: not in order, complete, accepted", () => {
    expect(scanVerdict(lines, {}, "v:other")).toEqual({ ok: false, error: "Ce produit ne fait pas partie de cette commande." });
    expect(scanVerdict(lines, { "p:p2": 2 }, "p:p2")).toEqual({ ok: false, error: "Quantité déjà complète." });
    expect(scanVerdict(lines, { "p:p2": 1 }, "p:p2")).toEqual({ ok: true, key: "p:p2" });
  });

  it("complete only when every line is exactly at its quantity; a manual line counts in full", () => {
    expect(isPackingComplete(lines, packingCounts(lines, ["v:v1", "p:p2", "p:p2"]))).toBe(false);
    expect(isPackingComplete(lines, packingCounts(lines, ["v:v1", "v:v1", "p:p2", "p:p2"]))).toBe(true);
    expect(isPackingComplete(lines, packingCounts(lines, ["v:v1", "v:v1"], ["p:p2"]))).toBe(true);
    expect(isPackingComplete([], {})).toBe(false);
  });

  it("eligibility: setting off = today's statuses exactly; on = packed EN_PREPARATION / ECHEC only", () => {
    expect(shippableOrderWhere(false)).toEqual({ status: { in: SHIPPABLE_ORDER_STATUSES } });
    expect(shippableOrderWhere(true)).toEqual({ status: { in: ["EN_PREPARATION", "ECHEC"] }, packedAt: { not: null } });
    const at = new Date();
    expect(shippableOrderProblem({ status: "CONFIRMEE", packedAt: null }, false)).toBeNull();
    expect(shippableOrderProblem({ status: "NOUVELLE", packedAt: null }, false)).toMatch(/statut/);
    expect(shippableOrderProblem({ status: "CONFIRMEE", packedAt: null }, true)).toMatch(/emballage/);
    expect(shippableOrderProblem({ status: "EN_PREPARATION", packedAt: null }, true)).toMatch(/emballage/);
    expect(shippableOrderProblem({ status: "EN_PREPARATION", packedAt: at }, true)).toBeNull();
    expect(shippableOrderProblem({ status: "ECHEC", packedAt: at }, true)).toBeNull(); // re-shipping a failed delivery
  });

  it("cancel / reopen clear the packing; other moves keep it", () => {
    expect(packingResetFor("ANNULEE")).toEqual({ packedAt: null, packedById: null, packingMethod: null });
    expect(packingResetFor("NOUVELLE")).toEqual({ packedAt: null, packedById: null, packingMethod: null });
    expect(packingResetFor("EN_PREPARATION")).toEqual({});
    expect(packingResetFor("EXPEDIEE")).toEqual({});
  });
});
