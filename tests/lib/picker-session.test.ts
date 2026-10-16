import { describe, expect, it } from "vitest";
import { addPickedUnit, keepListAfterPick, unitLineKey, unitLineLabel } from "@/lib/catalog/picker-session";

/**
 * The shared picking-session rules (docs/adr/0061) behind the reception and
 * in-store sale pickers: a click / keyboard pick keeps the result list open,
 * a scan clears it, the line is the exact unit, a repeat pick merges.
 */

type Line = { key: string; label: string; quantity: number };
const line = (key: string, label = key): Line => ({ key, label, quantity: 1 });

describe("keepListAfterPick", () => {
  it("click and keyboard keep the list; a scan clears it", () => {
    expect(keepListAfterPick("click")).toBe(true);
    expect(keepListAfterPick("keyboard")).toBe(true);
    expect(keepListAfterPick("scan")).toBe(false);
  });
});

describe("unitLineKey / unitLineLabel", () => {
  it("keys a variation by its own id, never its parent", () => {
    expect(unitLineKey({ productId: "p1", variationId: "v1" })).toBe("v:v1");
    expect(unitLineKey({ productId: "p1", variationId: null })).toBe("p:p1");
  });

  it("names the exact article", () => {
    expect(unitLineLabel({ name: "T-shirt lin", variantLabel: "Taille: M" })).toBe("T-shirt lin — Taille: M");
    expect(unitLineLabel({ name: "Bougie ambrée", variantLabel: null })).toBe("Bougie ambrée");
  });
});

describe("addPickedUnit", () => {
  it("adds a new line, increments an existing one, and stops at the cap", () => {
    const first = addPickedUnit([], "v:m", () => line("v:m"));
    expect(first.outcome).toBe("added");
    const again = addPickedUnit(first.lines, "v:m", () => line("v:m"));
    expect(again.outcome).toBe("incremented");
    expect(again.lines).toEqual([{ key: "v:m", label: "v:m", quantity: 2 }]);
    const capped = addPickedUnit(again.lines, "v:m", () => line("v:m"), { max: 2 });
    expect(capped.outcome).toBe("at_max");
    expect(capped.lines[0].quantity).toBe(2);
  });

  it("does not mutate the input lines", () => {
    const lines = [line("p:a")];
    addPickedUnit(lines, "p:a", () => line("p:a"));
    expect(lines[0].quantity).toBe(1);
  });

  it("a multi-pick session keeps every earlier line (reception: M, S, Bougie, L, L)", () => {
    let lines: Line[] = [];
    for (const key of ["v:m", "v:s", "p:bougie", "v:l", "v:l"]) {
      lines = addPickedUnit(lines, key, () => line(key)).lines;
    }
    expect(lines.map((l) => [l.key, l.quantity])).toEqual([
      ["v:m", 1],
      ["v:s", 1],
      ["p:bougie", 1],
      ["v:l", 2],
    ]);
  });
});
