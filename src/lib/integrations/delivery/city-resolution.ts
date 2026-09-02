import "server-only";

import { prisma } from "@/lib/prisma";
import { matchCityName, normalizeCityName, type CityMatchCandidate } from "./city-match";
import type { DeliveryProviderAdapter } from "./types";

/**
 * The generic, provider-agnostic layer that turns a local ASODITECH city
 * into one delivery provider's own city identifier — see
 * docs/adr/0018-delivery-city-mapping.md.
 *
 * Nothing here is carrier-specific. It composes two sources, in strict
 * precedence:
 *
 *   1. an explicit persisted `DeliveryCityMapping` for (provider, city) —
 *      recorded by an operator, and it ALWAYS wins;
 *   2. the provider's own destination catalogue, matched with the shared
 *      safe normalization (`matchCityName`: harmless case / accent /
 *      whitespace differences only, never a "closest" guess).
 *
 * Anything past that — an adapter's own last-resort resolution (e.g.
 * OzonExpress's `config.cityIdByName`) and the final typed failure — stays
 * inside the adapter. This function never guesses and never throws for a
 * normal unresolved / ambiguous state: it returns a typed result.
 */

/** The local city key actually stored and looked up — the shared
 * normalization, nothing more. Exported so the mapping Server Actions and
 * tests derive the key exactly one way. */
export function localCityKey(city: string): string {
  return normalizeCityName(city);
}

export type ProviderCityResolution =
  | {
      status: "resolved";
      providerCityId: string;
      providerCityName: string;
      /** Which source resolved it — for audit / diagnostics, never logic. */
      source: "mapping" | "catalogue";
    }
  | { status: "ambiguous"; candidates: CityMatchCandidate[] }
  | { status: "unresolved"; suggestions: CityMatchCandidate[] };

/**
 * True when this provider both declares the `FETCH_CITIES` capability and
 * actually implements `listCities`. The mapping layer only ever asks a
 * provider for its catalogue — or offers catalogue-backed mapping UI —
 * when this is true; otherwise no provider city id is ever fabricated.
 */
export function providerExposesCityCatalogue(adapter: DeliveryProviderAdapter): boolean {
  return adapter.capabilities.includes("FETCH_CITIES") && typeof adapter.listCities === "function";
}

/**
 * Resolves `localCity` to `shippingProviderId`'s own city id.
 *
 * `availableProviderCities` is the provider's catalogue as already
 * retrieved by the caller (empty array = no catalogue available, which is
 * legitimate — a provider may not expose one). The persisted mapping is
 * consulted regardless of whether a catalogue was supplied.
 */
export async function resolveProviderCity(params: {
  shippingProviderId: string;
  localCity: string;
  availableProviderCities: readonly CityMatchCandidate[];
}): Promise<ProviderCityResolution> {
  const key = localCityKey(params.localCity);

  // A — explicit persisted mapping. Wins over everything, and is returned
  // verbatim: the operator pinned this exact provider city id, so it is
  // sent even if the catalogue now spells the city differently or is
  // unavailable.
  if (key.length > 0) {
    const mapping = await prisma.deliveryCityMapping.findUnique({
      where: {
        shippingProviderId_localCityKey: { shippingProviderId: params.shippingProviderId, localCityKey: key },
      },
    });
    if (mapping) {
      return {
        status: "resolved",
        providerCityId: mapping.providerCityId,
        providerCityName: mapping.providerCityName,
        source: "mapping",
      };
    }
  }

  // B — safe exact normalized match against the provider's catalogue.
  const match = matchCityName(params.localCity, params.availableProviderCities);
  if (match.outcome === "resolved") {
    return { status: "resolved", providerCityId: match.id, providerCityName: match.name, source: "catalogue" };
  }
  if (match.outcome === "ambiguous") {
    return { status: "ambiguous", candidates: match.candidates };
  }
  return { status: "unresolved", suggestions: match.suggestions };
}
