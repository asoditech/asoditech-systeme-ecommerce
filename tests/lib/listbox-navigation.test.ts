import { describe, expect, it } from "vitest";
import { clampActive, listboxKey } from "@/lib/ui/listbox-navigation";

/** Keyboard rule of the order form's « Client » and « Ajouter un produit » pickers. */
describe("listboxKey", () => {
  it("arrows move and wrap; Home / End jump", () => {
    expect(listboxKey("ArrowDown", -1, 3)).toEqual({ kind: "move", active: 0 });
    expect(listboxKey("ArrowDown", 2, 3)).toEqual({ kind: "move", active: 0 });
    expect(listboxKey("ArrowUp", -1, 3)).toEqual({ kind: "move", active: 2 });
    expect(listboxKey("ArrowUp", 1, 3)).toEqual({ kind: "move", active: 0 });
    expect(listboxKey("Home", 2, 3)).toEqual({ kind: "move", active: 0 });
    expect(listboxKey("End", 0, 3)).toEqual({ kind: "move", active: 2 });
  });

  it("Enter selects only a highlighted option; with none highlighted it is ignored", () => {
    expect(listboxKey("Enter", 1, 3)).toEqual({ kind: "select", index: 1 });
    expect(listboxKey("Enter", -1, 3)).toEqual({ kind: "ignore" });
  });

  it("Escape closes even with no option; other keys and empty lists are ignored", () => {
    expect(listboxKey("Escape", -1, 0)).toEqual({ kind: "close" });
    expect(listboxKey("ArrowDown", -1, 0)).toEqual({ kind: "ignore" });
    expect(listboxKey("a", 0, 3)).toEqual({ kind: "ignore" });
  });

  it("clampActive keeps the highlight inside a shorter result list", () => {
    expect(clampActive(5, 3)).toBe(2);
    expect(clampActive(1, 3)).toBe(1);
    expect(clampActive(0, 0)).toBe(-1);
  });
});
