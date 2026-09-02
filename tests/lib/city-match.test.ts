import { describe, expect, it } from "vitest";
import { normalizeCityName, matchCityName } from "@/lib/integrations/delivery/city-match";

describe("normalizeCityName", () => {
  it("lowercases", () => {
    expect(normalizeCityName("CASABLANCA")).toBe("casablanca");
  });

  it("trims and collapses repeated internal whitespace", () => {
    expect(normalizeCityName("  Sidi   Maarouf  ")).toBe("sidi maarouf");
  });

  it("strips accents", () => {
    expect(normalizeCityName("Fès")).toBe("fes");
    expect(normalizeCityName("Salé")).toBe("sale");
  });

  it("never touches hyphens or apostrophes — distinct names stay distinct", () => {
    expect(normalizeCityName("Sidi Bennour")).not.toBe(normalizeCityName("Sidi-Bennour"));
    expect(normalizeCityName("Ait Melloul")).not.toBe(normalizeCityName("Ait-Melloul"));
  });
});

describe("matchCityName", () => {
  const catalogue = [
    { id: "1", name: "Casablanca" },
    { id: "2", name: "Rabat" },
    { id: "3", name: "Fès" },
  ];

  it("resolves an exact match", () => {
    expect(matchCityName("Casablanca", catalogue)).toEqual({ outcome: "resolved", id: "1", name: "Casablanca" });
  });

  it("resolves case-insensitively", () => {
    expect(matchCityName("casablanca", catalogue)).toEqual({ outcome: "resolved", id: "1", name: "Casablanca" });
    expect(matchCityName("CASABLANCA", catalogue)).toEqual({ outcome: "resolved", id: "1", name: "Casablanca" });
  });

  it("resolves through surrounding/internal whitespace differences", () => {
    expect(matchCityName("  Casablanca ", catalogue)).toEqual({ outcome: "resolved", id: "1", name: "Casablanca" });
  });

  it("resolves through an accent difference", () => {
    expect(matchCityName("Fes", catalogue)).toEqual({ outcome: "resolved", id: "3", name: "Fès" });
  });

  it("reports no match, never guessing a nearby id", () => {
    const result = matchCityName("Ifrane", catalogue);
    expect(result.outcome).toBe("unresolved");
  });

  it("offers substring-based suggestions on no match, purely informational", () => {
    const result = matchCityName("Casa", catalogue);
    expect(result.outcome).toBe("unresolved");
    if (result.outcome === "unresolved") {
      expect(result.suggestions).toEqual([{ id: "1", name: "Casablanca" }]);
    }
  });

  it("reports ambiguous — never silently picks the first — when two catalogue entries normalize the same", () => {
    const dupCatalogue = [
      { id: "1", name: "Casablanca" },
      { id: "99", name: "casablanca" }, // a real carrier bug/dup, or two legitimately distinct records sharing a name
    ];
    const result = matchCityName("Casablanca", dupCatalogue);
    expect(result.outcome).toBe("ambiguous");
    if (result.outcome === "ambiguous") {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates.map((c) => c.id).sort()).toEqual(["1", "99"]);
    }
  });

  it("an empty catalogue always reports unresolved with no suggestions", () => {
    expect(matchCityName("Casablanca", [])).toEqual({ outcome: "unresolved", suggestions: [] });
  });
});
