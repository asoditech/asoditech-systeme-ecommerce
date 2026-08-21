import "server-only";

import type { DeliveryCapability, DeliveryProviderAdapter } from "./types";
import { DeliveryUnsupportedCapabilityError } from "./errors";

/**
 * The delivery-provider adapter registry — a process-wide map from a
 * provider key (ShippingProvider.providerKey) to its adapter
 * implementation. See docs/adr/0012-delivery-provider-integration.md.
 *
 * Production adapters are registered exactly once, at module load, by
 * importing them in providers/index.ts. That file is currently empty (no
 * real carrier is chosen yet — see the ADR) so this registry is empty in
 * production today; the UI reflects that honestly rather than offering a
 * connector that doesn't exist. Tests register their own fixture adapter
 * directly (see tests/helpers/reference-delivery-provider.ts) — it is
 * never imported from providers/index.ts, so it can never reach a
 * production build.
 */
const registry = new Map<string, DeliveryProviderAdapter>();

export function registerDeliveryProvider(adapter: DeliveryProviderAdapter): void {
  if (registry.has(adapter.key)) {
    throw new Error(`Un connecteur de livraison "${adapter.key}" est déjà enregistré.`);
  }
  registry.set(adapter.key, adapter);
}

export function getDeliveryProvider(key: string): DeliveryProviderAdapter | undefined {
  return registry.get(key);
}

export function listDeliveryProviders(): DeliveryProviderAdapter[] {
  return [...registry.values()];
}

/** Test-only: resets the registry between test files/suites. */
export function __resetDeliveryProviderRegistryForTests(): void {
  registry.clear();
}

/**
 * Throws DeliveryUnsupportedCapabilityError (the typed "not supported"
 * result the phase brief calls for) unless the adapter declares it
 * supports `capability`. Callers still narrow the specific optional method
 * with a non-null assertion after this check (e.g. `adapter.createShipment!`)
 * — declared capability and implemented method are kept in sync by each
 * adapter's own author, not derived automatically, since a handful of
 * capabilities (FETCH_COST, UPDATE_SHIPMENT) don't map to one dedicated
 * method (cost rides along on createShipment/fetchStatus results).
 */
export function assertCapability(adapter: DeliveryProviderAdapter, capability: DeliveryCapability): void {
  if (!adapter.capabilities.includes(capability)) {
    throw new DeliveryUnsupportedCapabilityError(adapter.key, capability);
  }
}
