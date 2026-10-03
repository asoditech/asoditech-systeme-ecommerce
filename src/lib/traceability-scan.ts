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

/** French label for a non-active catalog status, or null when the unit is active. */
export function inactiveUnitLabel(status: "ACTIF" | "BROUILLON" | "ARCHIVE"): string | null {
  if (status === "ARCHIVE") return "Archivé";
  if (status === "BROUILLON") return "Brouillon";
  return null;
}
