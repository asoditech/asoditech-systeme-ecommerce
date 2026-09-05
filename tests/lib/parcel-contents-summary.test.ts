import { describe, expect, it } from "vitest";
import { buildParcelContentsSummary } from "@/lib/delivery";

describe("buildParcelContentsSummary", () => {
  it("lists quantity × name for each item", () => {
    expect(
      buildParcelContentsSummary([
        { nameSnapshot: "Tablier Élégant", quantity: 2 },
        { nameSnapshot: "Sac", quantity: 1 },
      ])
    ).toBe("2× Tablier Élégant, 1× Sac");
  });

  it("appends the variation's attribute values in parentheses", () => {
    expect(
      buildParcelContentsSummary([
        { nameSnapshot: "Tablier", quantity: 1, variation: { attributes: { Couleur: "Rouge", Taille: "M" } } },
      ])
    ).toBe("1× Tablier (Rouge, M)");
  });

  it("skips items with an empty name or a non-positive quantity", () => {
    expect(
      buildParcelContentsSummary([
        { nameSnapshot: "  ", quantity: 3 },
        { nameSnapshot: "Sac", quantity: 0 },
        { nameSnapshot: "Coffret", quantity: 1 },
      ])
    ).toBe("1× Coffret");
  });

  it("returns an empty string for no items", () => {
    expect(buildParcelContentsSummary([])).toBe("");
  });
});
