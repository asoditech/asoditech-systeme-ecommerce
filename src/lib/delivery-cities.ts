/**
 * City suggestions for the online order / customer forms — client-safe types
 * and the pure "which delivery company decides the list" rule.
 *
 *   0 active companies                     → free text
 *   1 active company                       → that company
 *   several, « Transporteur par défaut » set to one of them → that company
 *   several, no (valid) default            → free text
 *
 * The chosen company only decides WHICH city list is suggested; the shipment's
 * provider is still chosen at shipment creation. A company without a city
 * catalogue (`FETCH_CITIES`), or whose API fails, also means free text: city
 * entry is never blocked.
 */

export type CitySuggestions =
  | { mode: "list"; providerName: string; cities: string[] }
  | { mode: "free"; reason: CityFreeTextReason };

export type CityFreeTextReason = "no_provider" | "several_no_default" | "no_catalogue" | "unavailable";

export interface CitySourceProvider {
  id: string;
  name: string;
  capabilities: readonly string[];
}

export function pickCitySourceProvider<P extends CitySourceProvider>(
  activeProviders: readonly P[],
  defaultProviderId: string | null | undefined
): { provider: P } | { provider: null; reason: "no_provider" | "several_no_default" } {
  if (activeProviders.length === 0) return { provider: null, reason: "no_provider" };
  if (activeProviders.length === 1) return { provider: activeProviders[0] };
  const chosen = defaultProviderId ? activeProviders.find((p) => p.id === defaultProviderId) : undefined;
  return chosen ? { provider: chosen } : { provider: null, reason: "several_no_default" };
}

/** Distinct, trimmed, sorted (French collation) city names. */
export function normalizeCityNames(names: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of names) {
    const name = raw.trim();
    if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }));
}
