/**
 * Keyboard rule shared by the searchable pickers (order form « Client » and
 * « Ajouter un produit »): the search input keeps the focus and an "active"
 * option is moved with the arrows (WAI-ARIA combobox + listbox pattern,
 * `aria-activedescendant`). Pure — the hook below and the tests use it.
 *
 * `active` is -1 when no option is highlighted.
 */
export type ListboxKeyResult =
  | { kind: "move"; active: number }
  | { kind: "select"; index: number }
  | { kind: "close" }
  | { kind: "ignore" };

export function listboxKey(key: string, active: number, count: number): ListboxKeyResult {
  if (key === "Escape") return { kind: "close" };
  if (count <= 0) return { kind: "ignore" };
  switch (key) {
    case "ArrowDown":
      return { kind: "move", active: active < 0 || active >= count - 1 ? 0 : active + 1 };
    case "ArrowUp":
      return { kind: "move", active: active <= 0 ? count - 1 : active - 1 };
    case "Home":
      return { kind: "move", active: 0 };
    case "End":
      return { kind: "move", active: count - 1 };
    case "Enter":
      return active >= 0 && active < count ? { kind: "select", index: active } : { kind: "ignore" };
    default:
      return { kind: "ignore" };
  }
}

/** Keeps a highlighted index valid when the option list changes (shorter list, new search). */
export function clampActive(active: number, count: number): number {
  if (count <= 0) return -1;
  return active >= count ? count - 1 : active;
}
