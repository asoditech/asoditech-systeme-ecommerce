import "server-only";

import { prisma } from "@/lib/prisma";
import { fetchProviderCityCatalogue } from "@/lib/integrations/delivery/service";
import { normalizeCityNames, pickCitySourceProvider, type CitySuggestions } from "@/lib/delivery-cities";

/**
 * Server side of the online forms' city field (src/lib/delivery-cities.ts).
 * Reuses the existing carrier catalogue fetch (`fetchProviderCityCatalogue`,
 * the same one the « wrong city » mapping dialog uses) — no city data is
 * stored. A successful list is kept in memory for a while so opening the form
 * repeatedly doesn't call the carrier every time; failures are never cached.
 */

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; cities: string[] }>();

/** Test hook: forget cached catalogues. */
export function clearCityCatalogueCache(): void {
  cache.clear();
}

export async function getCitySuggestions(): Promise<CitySuggestions> {
  try {
    const [providers, settings] = await Promise.all([
      prisma.shippingProvider.findMany({
        where: { isActive: true },
        select: { id: true, name: true, capabilities: true },
        orderBy: { name: "asc" },
      }),
      prisma.businessSettings.findFirst({ select: { defaultShippingProviderId: true } }),
    ]);
    const picked = pickCitySourceProvider(providers, settings?.defaultShippingProviderId);
    if (!picked.provider) return { mode: "free", reason: picked.reason };
    const provider = picked.provider;
    if (!provider.capabilities.includes("FETCH_CITIES")) return { mode: "free", reason: "no_catalogue" };

    const hit = cache.get(provider.id);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { mode: "list", providerName: provider.name, cities: hit.cities };

    const { supported, cities } = await fetchProviderCityCatalogue(provider.id);
    if (!supported) return { mode: "free", reason: "no_catalogue" };
    const names = normalizeCityNames(cities.map((c) => c.name));
    if (names.length === 0) return { mode: "free", reason: "unavailable" }; // carrier down / not connected
    cache.set(provider.id, { at: Date.now(), cities: names });
    return { mode: "list", providerName: provider.name, cities: names };
  } catch (error) {
    console.error(`[delivery-cities] suggestions unavailable: ${error instanceof Error ? error.name : "unknown"}`);
    return { mode: "free", reason: "unavailable" };
  }
}
