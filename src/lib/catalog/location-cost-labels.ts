/**
 * Wording of a location purchase cost — one place, so every screen tells the
 * location's own cost apart from the global product cost it falls back to.
 * Pure strings (client-safe).
 */
export const LOCATION_COST_LABELS = {
  location: "Coût d'achat de cet emplacement",
  global: "Coût global du produit",
  usesGlobal: "Utilise le coût global du produit",
  missing: "Non renseigné",
} as const;

export type LocationCostSource = "location" | "global" | null;

/** The sub-label shown under an amount. */
export function locationCostSourceLabel(source: LocationCostSource): string {
  if (source === "location") return LOCATION_COST_LABELS.location;
  if (source === "global") return LOCATION_COST_LABELS.global;
  return LOCATION_COST_LABELS.missing;
}
