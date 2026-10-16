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
 * HTTP statuses that, on a parcel-creation request that WAS sent, count as a
 * definite refusal (nothing created): the request was rejected as
 * malformed / unauthenticated / forbidden / unknown endpoint / invalid data.
 * Any other non-2xx answer to a creation — 408, 409, 410, 5xx, 429, an
 * unexpected status — does not prove the carrier did not act, so it is
 * DeliveryOutcomeUnknownError (« à vérifier »), never ECHEC (2026-10-16
 * review). A carrier with its own documented refusal codes (Sendit
 * 250/251/252) passes them as `extra`.
 */
const DEFINITE_CREATE_REFUSAL_STATUSES: readonly number[] = [400, 401, 403, 404, 422];

export function isDefiniteCreateRefusalStatus(status: number, extra: readonly number[] = []): boolean {
  return DEFINITE_CREATE_REFUSAL_STATUSES.includes(status) || extra.includes(status);
}

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
