/**
 * The order form's/dialog's "write the city exactly as the carrier has it"
 * warning — de-hardcoded from OzonExpress (Group 2 of the post-audit UX
 * fixes). Pure decision logic only: given the tenant's active shipping
 * providers, which message tone applies and which provider (if any) to
 * name. No provider name is ever hard-coded here; the only provider-
 * specific fact used is the existing `FETCH_CITIES` capability
 * (docs/adr/0018-delivery-city-mapping.md) — declared today by the
 * OzonExpress adapter and not by Aramex, but this makes no assumption
 * about which key that is: a future FETCH_CITIES-capable provider is
 * handled identically with zero changes here.
 *
 * `providers` is the tenant's ACTIVE `ShippingProvider` rows (their own
 * `name` + persisted `capabilities`, docs/adr/0012) — not the adapter
 * registry, so a MANUEL/FLOTTE_INTERNE provider (no adapter at all) is
 * handled the same as any other: no capabilities, so `exact` never
 * triggers for it, which is correct (there is no carrier catalogue to
 * match against).
 */

export interface DeliveryProviderForGuidance {
  name: string;
  capabilities: string[];
}

export type CityGuidance =
  /** Exactly one active provider needs an exact catalogue match. */
  | { tone: "exact"; providerName: string }
  /** A provider is active, but not known to require an exact catalogue
   * match — or more than one is active and it would be misleading to name
   * just one. Named only when there is exactly one active provider. */
  | { tone: "generic"; providerName: string | null }
  /** No delivery provider is configured at all. */
  | { tone: "none" };

export function cityGuidanceFromProviders(providers: DeliveryProviderForGuidance[]): CityGuidance {
  if (providers.length === 0) return { tone: "none" };
  const exactMatchProviders = providers.filter((p) => p.capabilities.includes("FETCH_CITIES"));
  if (exactMatchProviders.length === 1) return { tone: "exact", providerName: exactMatchProviders[0].name };
  // Zero exact-match providers, or several active providers at once (which
  // one eventually ships this order isn't decided at this point in the
  // flow — see docs/adr/0018) — name the single active provider when there
  // is one, otherwise stay fully generic rather than guess.
  return { tone: "generic", providerName: providers.length === 1 ? providers[0].name : null };
}

/**
 * The actual warning text for each tone — used by both order-form.tsx and
 * edit-shipping-address-dialog.tsx so the wording never drifts between them.
 *
 * Provider-neutral by requirement (Batch 9, Group 1): never names the
 * carrier in the user-facing message, even when exactly one is active and
 * even when it is FETCH_CITIES-capable. `guidance.providerName` still exists
 * on the `CityGuidance` value above for any future non-message use — this
 * function deliberately never reads it. The `exact` tone keeps a stronger
 * phrasing ("empêchera" vs "peut empêcher") since that fact — an exact
 * catalogue match is required — is real and worth conveying without naming
 * who enforces it.
 */
export function cityGuidanceMessage(guidance: CityGuidance): string {
  switch (guidance.tone) {
    case "exact":
      return "Écrivez le nom de la ville exactement comme attendu par le transporteur sélectionné. Une orthographe différente empêchera la création du colis.";
    case "generic":
    case "none":
      return "Écrivez le nom de la ville exactement comme attendu par le transporteur sélectionné. Une orthographe différente peut empêcher la création du colis.";
  }
}
