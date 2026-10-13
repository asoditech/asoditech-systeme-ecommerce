import { describe, expect, it } from "vitest";
import { missingCostMessage, missingCostProductWhere, missingCostVariationWhere } from "@/lib/catalog/missing-cost";

/** B3 — pure part of the « coût d'achat manquant » rule (no database). */
describe("missing-cost rules", () => {
  it("no message at zero; the message says what is incomplete", () => {
    expect(missingCostMessage({ units: 0 })).toBeNull();
    expect(missingCostMessage({ units: 3 })).toBe("3 produit(s)/variante(s) sans coût d'achat : les marges et rapports financiers sont incomplets.");
  });

  it("ACTIF only, and the product cost is the fallback for its variations", () => {
    expect(missingCostProductWhere()).toMatchObject({ status: "ACTIF", cost: null });
    expect(missingCostVariationWhere()).toEqual({ isActive: true, cost: null, product: { status: "ACTIF", cost: null } });
  });
});
