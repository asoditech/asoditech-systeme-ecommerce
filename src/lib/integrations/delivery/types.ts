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
  | "WEBHOOKS"
  // The provider exposes an authoritative catalogue of the destinations it
  // serves, each with the provider's own city identifier — retrievable via
  // `listCities`. Declared ONLY by providers that both implement
  // `listCities` and genuinely require a provider-specific destination id
  // (rather than a free-text city). Drives the persistent city-mapping
  // layer (docs/adr/0018-delivery-city-mapping.md): a provider without this
  // capability never gets fabricated provider city ids and the mapping UI
  // tells the operator so. Never assumed — shipment creation does not
  // depend on it.
  | "FETCH_CITIES"
  // Group several already-created shipments into one carrier "delivery
  // note" / manifest / bordereau — the handover document (plus parcel
  // labels) the operator prints and gives the carrier. See
  // docs/adr/0015-delivery-manifest.md. Declared only by carriers whose
  // API genuinely has this workflow (OzonExpress does).
  | "GENERATE_MANIFEST";

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
  /** Optional read-only facts gathered during the connection test that are
   * safe to show the operator (e.g. `{ "villes desservies": 120 }`). Never
   * a credential, token, or URL. Surfaced in the "Tester la connexion"
   * success message. */
  details?: Record<string, string | number>;
}

/** One destination in a carrier's service-area catalogue. `id` is the
 * carrier's own identifier (kept as a string even when numeric); `name` is
 * the human city name. Optional `region` when the carrier groups cities. */
export interface DeliveryCity {
  id: string;
  name: string;
  region?: string | null;
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
  /**
   * The provider's own city identifier, already resolved by the generic
   * city-mapping layer (docs/adr/0018-delivery-city-mapping.md) — set when
   * a persisted `DeliveryCityMapping` matched, or the provider's catalogue
   * had exactly one safe normalized match. `null` when neither did: the
   * adapter then applies its own last-resort resolution (e.g. OzonExpress's
   * `config.cityIdByName`) and, failing that, throws a typed error BEFORE
   * any external call — never guesses. An adapter that needs a
   * provider-specific city id MUST prefer this value over re-deriving one
   * from `city`.
   */
  resolvedProviderCityId: string | null;
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

export interface GenerateManifestAdapterInput {
  /** The carrier's own shipment ids (`Shipment.externalId`) to place on
   * one handover document. The caller guarantees they all belong to the
   * same provider row and are ready for handover. */
  externalIds: string[];
}

/**
 * A printable document the carrier exposes for a manifest reference — the
 * bordereau PDF, an A4 label sheet, etc. `url` is opened by the operator
 * in their browser; it is NEVER fetched or proxied server-side (the
 * carrier's portal owns rendering and its own auth). The adapter must
 * guarantee `url` is an absolute `https:` URL.
 */
export interface DeliveryManifestDocument {
  /** French label shown on the button, e.g. "Bordereau (BL)". */
  label: string;
  url: string;
}

export interface GenerateManifestAdapterResult {
  /** The carrier's own manifest / delivery-note reference — required,
   * never fabricated. */
  externalRef: string;
  /** Parcel count the carrier itself confirmed on the manifest, when its
   * response reports one; `null` otherwise (never inferred from the input
   * length). */
  parcelCount: number | null;
  /** Printable documents for this manifest reference. `[]` when the
   * carrier exposes none. */
  documents: DeliveryManifestDocument[];
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

  /** Retrieves the carrier's authoritative destination catalogue (the set
   * of cities/areas it delivers to, with the carrier's own ids). Optional —
   * only carriers whose API requires a carrier-specific destination id
   * (rather than a free-text city) implement it. Read-only; safe to call
   * during a connection test. */
  listCities?(
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<DeliveryCity[]>;

  /** Maps one raw provider status string to a local ShipmentStatus value.
   * Returns null for a status this adapter doesn't recognize — the caller
   * must preserve the raw string as metadata and never guess a local
   * status for it (see docs/adr/0012, "Status synchronization"). Every
   * status the adapter's own carrier API documents should appear in an
   * explicit mapping table inside the adapter, exactly like
   * woocommerce/mapper.ts:mapOrderStatus. Required whenever FETCH_STATUS
   * or WEBHOOKS is declared. */
  mapStatus?(rawStatus: string): ShipmentStatusValue | null;

  /** Groups the given already-created shipments (by their carrier
   * `externalId`) into one carrier delivery note / manifest and returns
   * its reference plus any printable-document URLs. Required whenever the
   * adapter declares `GENERATE_MANIFEST`. Whatever multi-step dance the
   * carrier's API needs (OzonExpress: create → add parcels → save) is the
   * adapter's concern — the caller only sees the outcome. See
   * docs/adr/0015-delivery-manifest.md. */
  generateManifest?(
    input: GenerateManifestAdapterInput,
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<GenerateManifestAdapterResult>;

  /** Verifies a raw webhook delivery's signature. Must use a
   * constant-time comparison (see shared/hmac.ts). */
  verifyWebhookSignature?(rawBody: string, headers: Record<string, string>, secret: string): boolean;

  /** Parses an already-signature-verified raw webhook body into a
   * normalized event. Returns null for a topic this adapter doesn't act on
   * (acknowledge, don't reject — see docs/adr/0010's webhook handling). */
  mapWebhookPayload?(rawBody: string, headers: Record<string, string>): DeliveryWebhookEvent | null;
}
