import "server-only";

import type { ShipmentStatusValue } from "@/lib/validation/delivery";

/**
 * The generic delivery-provider adapter contract. See
 * docs/adr/0012-delivery-provider-integration.md.
 *
 * A real carrier's adapter (once one is chosen — see the ADR's "Provider
 * selection" section) implements this against its own REST/SOAP API,
 * exactly like src/lib/integrations/woocommerce and
 * src/lib/integrations/shopify implement an e-commerce-platform contract.
 * Nothing here assumes any specific carrier's auth scheme, request shape,
 * or status vocabulary.
 */

/** Capabilities a provider adapter can claim to support. Never assumed —
 * always declared explicitly by the adapter (`capabilities`) and checked
 * before use (`assertCapability`). */
export type DeliveryCapability =
  | "CREATE_SHIPMENT"
  | "CANCEL_SHIPMENT"
  | "FETCH_STATUS"
  | "FETCH_COST"
  | "WEBHOOKS";

/**
 * Deliberately not modeled as a capability in this phase: updating an
 * already-created shipment (address/notes) after the fact. No adapter
 * method, Server Action, or UI exists for it — most carriers don't support
 * post-creation edits anyway, and the existing MANUEL flow doesn't offer
 * this either. Add it (method + capability + action + UI, all together)
 * only when a real provider's API documents genuine support for it.
 */

/** Credentials/config are opaque at this layer — each adapter defines and
 * validates its own shape (mirroring woocommerce/types.ts, shopify/types.ts).
 * Never logged, never returned to the client. */
export type DeliveryCredentials = Record<string, unknown>;
export type DeliveryProviderConfig = Record<string, unknown>;

export interface DeliveryConnectionResult {
  ok: true;
}

export interface CreateShipmentAdapterInput {
  /** Local Shipment.id, passed through for idempotency-key derivation if the
   * provider supports one — never used as the provider's own id. */
  localShipmentId: string;
  orderNumber: string;
  recipientName: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  region: string | null;
  country: string;
  phone: string | null;
  /** Cash-on-delivery amount to collect, if the order is COD — null if not
   * applicable. Never assumed to be the order total unless the adapter's
   * own carrier semantics document that. */
  codAmount: number | null;
  currency: string;
  notes: string | null;
}

export interface CreateShipmentAdapterResult {
  /** The provider's own shipment/parcel id — required, never fabricated. */
  externalId: string;
  trackingNumber: string | null;
  /** Only set if the provider's own response actually supplies or
   * documents a deterministic tracking URL — never constructed by
   * guessing a URL pattern. */
  trackingUrl: string | null;
  /** Only set if the provider's create-shipment response actually returns
   * a cost — never estimated. */
  cost: number | null;
  /** The provider's raw initial status string, preserved verbatim. */
  rawStatus: string | null;
}

export interface CancelShipmentAdapterInput {
  externalId: string;
}

export interface FetchStatusAdapterInput {
  externalId: string;
}

export interface FetchStatusAdapterResult {
  rawStatus: string;
  trackingUrl: string | null;
  /** Only set if this specific status-fetch response actually includes a
   * cost figure — never estimated, never carried over from a stale value. */
  cost: number | null;
}

export interface DeliveryWebhookEvent {
  /** The provider's own per-delivery id, used for replay protection —
   * required for any provider that claims WEBHOOKS. */
  deliveryId: string;
  topic: string;
  /** The provider's own shipment id this event is about. */
  externalId: string | null;
  rawStatus: string | null;
}

/**
 * One credential input an adapter needs, so the "Configurer" UI can render
 * proper typed fields (label, password masking, help text) instead of
 * asking the operator to hand-write a JSON blob. Optional: an adapter that
 * doesn't declare this falls back to the raw-JSON credential editor. The
 * field `name`s become the keys of the JSON object stored (encrypted) in
 * `ShippingProvider.credentialsEncrypted` — the adapter still validates the
 * assembled object itself (never trust the UI). `type: "password"` only
 * affects rendering; every field is encrypted at rest identically.
 */
export interface DeliveryCredentialField {
  name: string;
  label: string;
  type: "text" | "password";
  required: boolean;
  help?: string;
}

export interface DeliveryProviderAdapter {
  /** Unique registry key, e.g. "acme-carrier". Never a display label. */
  readonly key: string;
  /** French, user-facing name shown in the provider-selection UI. */
  readonly displayName: string;
  readonly capabilities: readonly DeliveryCapability[];
  /** Optional typed credential schema for the config UI — see
   * DeliveryCredentialField. */
  readonly credentialFields?: readonly DeliveryCredentialField[];

  /** Performs one real authenticated, read-only request to confirm the
   * credentials/config actually work. This is the only path allowed to
   * report a genuine connected state — see
   * docs/adr/0012-delivery-provider-integration.md. */
  testConnection(credentials: DeliveryCredentials, config: DeliveryProviderConfig): Promise<DeliveryConnectionResult>;

  createShipment?(
    input: CreateShipmentAdapterInput,
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<CreateShipmentAdapterResult>;

  cancelShipment?(
    input: CancelShipmentAdapterInput,
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<void>;

  fetchStatus?(
    input: FetchStatusAdapterInput,
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<FetchStatusAdapterResult>;

  /** Maps one raw provider status string to a local ShipmentStatus value.
   * Returns null for a status this adapter doesn't recognize — the caller
   * must preserve the raw string as metadata and never guess a local
   * status for it (see docs/adr/0012, "Status synchronization"). Every
   * status the adapter's own carrier API documents should appear in an
   * explicit mapping table inside the adapter, exactly like
   * woocommerce/mapper.ts:mapOrderStatus. Required whenever FETCH_STATUS
   * or WEBHOOKS is declared. */
  mapStatus?(rawStatus: string): ShipmentStatusValue | null;

  /** Verifies a raw webhook delivery's signature. Must use a
   * constant-time comparison (see shared/hmac.ts). */
  verifyWebhookSignature?(rawBody: string, headers: Record<string, string>, secret: string): boolean;

  /** Parses an already-signature-verified raw webhook body into a
   * normalized event. Returns null for a topic this adapter doesn't act on
   * (acknowledge, don't reject — see docs/adr/0010's webhook handling). */
  mapWebhookPayload?(rawBody: string, headers: Record<string, string>): DeliveryWebhookEvent | null;
}
