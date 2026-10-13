/**
 * Traçabilité camera scan → the page's existing search. A scanned code is
 * turned into the same `?q=` URL the manual search field produces (and
 * any previously chosen `unit` is dropped), so the lookup, its tenant and
 * location scoping, and every empty/unknown state stay exactly the page's
 * own: navigating is a read-only GET — nothing is written by a scan.
 * Returns null for an empty/whitespace code (nothing to search).
 */
export const TRACEABILITY_PATH = "/tracabilite";

export function traceabilitySearchHref(code: string | null | undefined): string | null {
  const q = (code ?? "").trim();
  if (!q) return null;
  return `${TRACEABILITY_PATH}?${new URLSearchParams({ q }).toString()}`;
}

/** The page's `unit` key for one article: `v:<variationId>` or `p:<productId>`. */
export function traceUnitKey(unit: { productId: string; variationId: string | null }): string {
  return unit.variationId ? `v:${unit.variationId}` : `p:${unit.productId}`;
}

/**
 * The picker's choice → the page's existing `?q=…&unit=…` URL (the same one
 * the « N articles correspondent » list links to). `q` is the search the
 * picker ran, so the page's own lookup returns the same candidates and opens
 * the chosen one; with an empty search (initial list) the article's SKU is
 * used — an exact reference the page's lookup resolves to it.
 */
export function traceabilityUnitHref(query: string, unit: { productId: string; variationId: string | null; sku: string }): string {
  const q = query.trim() || unit.sku;
  return `${TRACEABILITY_PATH}?${new URLSearchParams({ q, unit: traceUnitKey(unit) }).toString()}`;
}

/** French label for a non-active catalog status, or null when the unit is active. */
export function inactiveUnitLabel(status: "ACTIF" | "BROUILLON" | "ARCHIVE"): string | null {
  if (status === "ARCHIVE") return "Archivé";
  if (status === "BROUILLON") return "Brouillon";
  return null;
}
