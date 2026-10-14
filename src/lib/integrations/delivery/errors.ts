import "server-only";

import type { DeliveryCapability } from "./types";

/**
 * Normalized delivery-provider error hierarchy, mirroring
 * src/lib/integrations/woocommerce/errors.ts and
 * src/lib/integrations/shopify/errors.ts. Every adapter should throw one of
 * these (never a raw fetch/parsing error) so callers get a safe, French,
 * user-facing message with no leaked response body, URL, or credential.
 */
export class DeliveryProviderError extends Error {}

export class DeliveryConfigError extends DeliveryProviderError {}
export class DeliveryAuthError extends DeliveryProviderError {}
export class DeliveryPermissionError extends DeliveryProviderError {}
export class DeliveryNotFoundError extends DeliveryProviderError {}
export class DeliveryTimeoutError extends DeliveryProviderError {}
export class DeliveryRateLimitError extends DeliveryProviderError {}
export class DeliveryUnavailableError extends DeliveryProviderError {}
export class DeliveryMalformedResponseError extends DeliveryProviderError {}

/**
 * A non-idempotent carrier request (parcel creation) was SENT but its outcome
 * is unknown: timeout, connection lost mid-request, 5xx, or a 2xx body that
 * can't be read. The carrier may well have created the parcel. Never retried
 * automatically; createShipmentViaProvider keeps the reserved shipment active
 * (EN_ATTENTE) and flags it « à vérifier » so no second parcel can be created
 * for the order until a person has checked the carrier's portal. Adapters
 * throw this only when the request may have reached the carrier — a failure
 * known to happen before sending stays a regular typed error.
 */
export class DeliveryOutcomeUnknownError extends DeliveryProviderError {}

/**
 * Thrown by assertCapability() — the typed "not supported" result Step 1
 * of the phase brief calls for, instead of silently pretending an
 * unimplemented operation succeeded.
 */
export class DeliveryUnsupportedCapabilityError extends DeliveryProviderError {
  constructor(providerKey: string, capability: DeliveryCapability) {
    super(`Le connecteur "${providerKey}" ne prend pas en charge cette opération (${capability}).`);
  }
}
