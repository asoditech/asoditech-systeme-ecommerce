import { describe, expect, it } from "vitest";
import { generateAttributeCombinations, attributesKey, suggestVariationSku, productCreateRedirectPath } from "@/lib/catalog/variations";

/**
 * Batch 4 (Variant System Rebuild) — pure combination generation + SKU
 * suggestion, kept DB-free so they're exhaustively unit-testable.
 */
describe("generateAttributeCombinations", () => {
  it("2 colors × 3 sizes = 6 deterministic combinations, options first then values in order", () => {
    const combos = generateAttributeCombinations([
      { name: "Couleur", values: ["Noir", "Blanc"] },
      { name: "Taille", values: ["S", "M", "L"] },
    ]);
    expect(combos).toEqual([
      { Couleur: "Noir", Taille: "S" },
      { Couleur: "Noir", Taille: "M" },
      { Couleur: "Noir", Taille: "L" },
      { Couleur: "Blanc", Taille: "S" },
      { Couleur: "Blanc", Taille: "M" },
      { Couleur: "Blanc", Taille: "L" },
    ]);
  });

  it("de-duplicates repeated values within one option (case/whitespace-insensitive)", () => {
    const combos = generateAttributeCombinations([{ name: "Couleur", values: ["Noir", " noir ", "Blanc"] }]);
    expect(combos).toEqual([{ Couleur: "Noir" }, { Couleur: "Blanc" }]);
  });

  it("a single option with N values produces N combinations", () => {
    const combos = generateAttributeCombinations([{ name: "Taille", values: ["S", "M", "L"] }]);
    expect(combos).toHaveLength(3);
  });

  it("three options multiply together (2 × 2 × 2 = 8)", () => {
    const combos = generateAttributeCombinations([
      { name: "Couleur", values: ["Noir", "Blanc"] },
      { name: "Taille", values: ["S", "M"] },
      { name: "Matière", values: ["Coton", "Lin"] },
    ]);
    expect(combos).toHaveLength(8);
  });

  it("ignores an empty option (blank name or no values) without crashing", () => {
    const combos = generateAttributeCombinations([
      { name: "Couleur", values: ["Noir"] },
      { name: "", values: ["x"] },
      { name: "Vide", values: [] },
    ]);
    expect(combos).toEqual([{ Couleur: "Noir" }]);
  });

  it("returns an empty array for no usable options", () => {
    expect(generateAttributeCombinations([])).toEqual([]);
    expect(generateAttributeCombinations([{ name: "", values: [] }])).toEqual([]);
  });
});

describe("attributesKey", () => {
  it("is order-independent — {Couleur, Taille} and {Taille, Couleur} produce the same key", () => {
    expect(attributesKey({ Couleur: "Noir", Taille: "M" })).toBe(attributesKey({ Taille: "M", Couleur: "Noir" }));
  });

  it("is case/whitespace-insensitive on both keys and values", () => {
    expect(attributesKey({ couleur: " Noir " })).toBe(attributesKey({ Couleur: "noir" }));
  });

  it("distinguishes genuinely different combinations", () => {
    expect(attributesKey({ Couleur: "Noir", Taille: "M" })).not.toBe(attributesKey({ Couleur: "Noir", Taille: "L" }));
  });
});

describe("suggestVariationSku", () => {
  it("builds REFERENCE-VALUE1-VALUE2 from the product reference and each attribute value, uppercased/accent-stripped", () => {
    expect(suggestVariationSku("TSH-BADYSS", { Couleur: "Noir", Taille: "M" })).toBe("TSH-BADYSS-NOIR-M");
  });

  it("falls back to the product name when there is no reference", () => {
    expect(suggestVariationSku(null, { Taille: "M" })).toBe("M");
    expect(suggestVariationSku("", { Taille: "M" })).toBe("M");
  });

  it("strips accents and non-alphanumeric characters", () => {
    expect(suggestVariationSku("Étoffé", { Couleur: "Écru" })).toBe("ETOFFE-ECRU");
  });

  it("never invents a colour-abbreviation dictionary — the literal value is kept", () => {
    // Deliberately NOT "TSH-BADYSS-BLK-M" — see suggestVariationSku's own doc comment.
    expect(suggestVariationSku("TSH-BADYSS", { Couleur: "Noir", Taille: "M" })).not.toContain("BLK");
  });
});

/** Batch 9, Group 3 — variant discoverability: where "create product" lands afterward. */
describe("productCreateRedirectPath", () => {
  it("lands on the plain product page when the operator did not flag variants", () => {
    expect(productCreateRedirectPath("prod_1", false)).toBe("/produits/prod_1");
  });

  it("lands on the Variations tab, generator auto-open flagged, when the operator checked variants", () => {
    expect(productCreateRedirectPath("prod_1", true)).toBe("/produits/prod_1?tab=variations&variants=1");
  });
});
