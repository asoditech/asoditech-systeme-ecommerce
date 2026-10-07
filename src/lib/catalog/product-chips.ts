/**
 * Compact « Produits » summary of an order / sale: one chip per product line
 * (same label merged, quantities summed), at most `max` chips plus « +N ».
 * Pure and client-safe — used by the Online and Offline lists and the pickers.
 */
export interface ChipLine {
  name: string;
  quantity: number;
  /** Variation attributes ({ Couleur: "Rouge" }) — added to the name when not already in it. */
  attributes?: unknown;
}

export interface ProductChip {
  label: string;
  quantity: number;
}

/** Lower-cased, accent-free words: "T-shirt Écru" → ["t", "shirt", "ecru"]. */
function words(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Whether `value` appears in `name` as whole word(s), in order — "L" is in "Polo L", not in "Polo". */
function containsWords(name: string[], value: string[]): boolean {
  if (value.length === 0 || value.length > name.length) return false;
  for (let i = 0; i + value.length <= name.length; i++) {
    if (value.every((w, j) => name[i + j] === w)) return true;
  }
  return false;
}

/**
 * "Basket — Rouge / 42". An option value the name already shows as a whole
 * word (e.g. an imported « T-shirt - Rouge ») is not repeated; a value that is
 * only a few letters inside a word ("L" in "Polo", "S" in "Badyss") is still added.
 */
export function productLineLabel(name: string, attributes?: unknown): string {
  if (!attributes || typeof attributes !== "object") return name;
  const nameWords = words(name);
  const extra = Object.values(attributes as Record<string, unknown>).filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0 && !containsWords(nameWords, words(v))
  );
  return extra.length > 0 ? `${name} — ${extra.join(" / ")}` : name;
}

export function productChips(lines: ChipLine[], max = 2): { chips: ProductChip[]; more: number } {
  const merged = new Map<string, ProductChip>();
  for (const line of lines) {
    const label = productLineLabel(line.name, line.attributes);
    const chip = merged.get(label);
    if (chip) chip.quantity += line.quantity;
    else merged.set(label, { label, quantity: line.quantity });
  }
  const all = [...merged.values()];
  return { chips: all.slice(0, max), more: Math.max(0, all.length - max) };
}
