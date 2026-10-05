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

/** Accent/case-insensitive key for matching city names ("Fès" ~ "fes"). */
export function cityMatchKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Filters the carrier's city list for the dropdown: names STARTING with the
 * typed text first, then names containing it, each in list order; an empty
 * query returns the list as is. Capped (`limit`) so a long catalogue never
 * renders thousands of rows. UI only — the value entered stays free text.
 */
export function filterCities(cities: readonly string[], query: string, limit = 50): string[] {
  const q = cityMatchKey(query);
  if (!q) return cities.slice(0, limit);
  const starts: string[] = [];
  const contains: string[] = [];
  for (const city of cities) {
    const key = cityMatchKey(city);
    if (key.startsWith(q)) starts.push(city);
    else if (key.includes(q)) contains.push(city);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}
