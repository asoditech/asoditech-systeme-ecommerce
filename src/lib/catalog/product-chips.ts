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

/** "Basket — Rouge / 42"; values the name already contains (e.g. an imported « T-shirt - Rouge ») are not repeated. */
export function productLineLabel(name: string, attributes?: unknown): string {
  if (!attributes || typeof attributes !== "object") return name;
  const lower = name.toLowerCase();
  const extra = Object.values(attributes as Record<string, unknown>).filter(
    (v): v is string => typeof v === "string" && v.length > 0 && !lower.includes(v.toLowerCase())
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
