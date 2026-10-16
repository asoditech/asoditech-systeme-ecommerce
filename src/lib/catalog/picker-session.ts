/**
 * The shared product-picking SESSION rules (docs/adr/0061) — pure, client-safe,
 * used by every multi-line picker (reception, in-store sale; the order form's
 * popover follows the same rules) so they cannot drift apart again.
 *
 * - A pick from the result list (mouse click or keyboard Enter on the
 *   highlighted row) KEEPS the list and the query: the operator adds article
 *   1, 2, 3… without searching again. « Terminé » closes it.
 * - A scan (hardware scanner Enter on an exact code, or the camera) clears the
 *   query and the list, ready for the next scan.
 * - The line key is the exact unit — the variation when there is one, never
 *   its parent — so a line always shows the article really picked.
 */

export type PickSource = "click" | "keyboard" | "scan";

export function keepListAfterPick(source: PickSource): boolean {
  return source !== "scan";
}

export interface PickableUnit {
  productId: string;
  variationId: string | null;
  name: string;
  variantLabel: string | null;
  sku: string;
}

/** `v:<variationId>` for a variation, `p:<productId>` for a simple product. */
export function unitLineKey(u: { productId: string | null; variationId: string | null }): string {
  return u.variationId ? `v:${u.variationId}` : `p:${u.productId}`;
}

/** « T-shirt lin — Taille: M » — the exact article, as shown on the line. */
export function unitLineLabel(u: { name: string; variantLabel: string | null }): string {
  return u.variantLabel ? `${u.name} — ${u.variantLabel}` : u.name;
}

export type AddOutcome = "added" | "incremented" | "at_max";

/**
 * A pick → the next lines, following the workflow's own rule for an article
 * already on the document: `merge` adds 1 to its quantity (reception, sale —
 * their existing rule), optionally capped (sale: available stock).
 */
export function addPickedUnit<L extends { key: string; quantity: number }>(
  lines: readonly L[],
  key: string,
  makeLine: () => L,
  opts: { max?: number | null } = {}
): { lines: L[]; outcome: AddOutcome } {
  const existing = lines.find((l) => l.key === key);
  if (!existing) return { lines: [...lines, makeLine()], outcome: "added" };
  if (opts.max != null && existing.quantity + 1 > opts.max) return { lines: [...lines], outcome: "at_max" };
  return { lines: lines.map((l) => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l)), outcome: "incremented" };
}
