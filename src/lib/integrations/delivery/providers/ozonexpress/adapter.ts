import "server-only";

import { DeliveryConfigError, DeliveryNotFoundError } from "@/lib/integrations/delivery/errors";
import type {
  CreateShipmentAdapterInput,
  CreateShipmentAdapterResult,
  DeliveryConnectionResult,
  DeliveryCredentials,
  DeliveryProviderAdapter,
  DeliveryProviderConfig,
  FetchStatusAdapterInput,
  FetchStatusAdapterResult,
} from "@/lib/integrations/delivery/types";
import type { ShipmentStatusValue } from "@/lib/validation/delivery";
import { OzonExpressClient } from "./client";
import {
  buildAddParcelForm,
  mapOzonExpressStatus,
  parseAddParcelResponse,
  parseTrackingResponse,
} from "./mapper";
import {
  ozonExpressConfigSchema,
  ozonExpressCredentialsSchema,
  type OzonExpressConfig,
  type OzonExpressCredentials,
} from "./types";

/**
 * OzonExpress Morocco delivery-provider adapter.
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  ⚠️  UNVERIFIED CONTRACT — NOT REGISTERED IN PRODUCTION
 * ═══════════════════════════════════════════════════════════════════════
 * OzonExpress publishes no official merchant API documentation. This
 * adapter is a faithful implementation of the contract that is
 * consistently reported across several independent third-party
 * integrations, but every endpoint, field, and status string is
 * corroborated, NOT confirmed. It is intentionally NOT wired into
 * `src/lib/integrations/delivery/providers/index.ts` — enabling it is a
 * one-line change an operator makes only after OzonExpress confirms the
 * contract (or supplies real docs). See
 * docs/adr/0013-ozonexpress-integration.md.
 *
 * Capabilities: CREATE_SHIPMENT, FETCH_STATUS, FETCH_COST.
 *   - CANCEL_SHIPMENT is deliberately NOT declared — no OzonExpress
 *     cancellation endpoint is known to exist. Attempting to cancel a
 *     provider-backed shipment therefore fails with the shared typed
 *     "unsupported" error (registry.assertCapability), never a silent
 *     local-only cancellation.
 *   - WEBHOOKS is deliberately NOT declared — OzonExpress has no known
 *     callback mechanism. Status stays poll-only via `syncShipmentStatus`.
 */

export const OZONEXPRESS_PROVIDER_KEY = "ozonexpress";

/** Machine-readable marker that this adapter's contract has not been
 * verified against official OzonExpress documentation or a live account.
 * Surfaced in the config UI and the ADR. */
export const OZONEXPRESS_VERIFICATION = "UNVERIFIED" as const;

function parseCredentials(raw: DeliveryCredentials): OzonExpressCredentials {
  const parsed = ozonExpressCredentialsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DeliveryConfigError(
      "Identifiants OzonExpress incomplets — l'identifiant client et la clé API sont requis."
    );
  }
  return parsed.data;
}

function parseConfig(raw: DeliveryProviderConfig): OzonExpressConfig {
  const parsed = ozonExpressConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new DeliveryConfigError("Configuration du connecteur OzonExpress invalide.");
  }
  return parsed.data;
}

export const ozonExpressAdapter: DeliveryProviderAdapter = {
  key: OZONEXPRESS_PROVIDER_KEY,
  displayName: "OzonExpress (Maroc) — contrat non vérifié",
  capabilities: ["CREATE_SHIPMENT", "FETCH_STATUS", "FETCH_COST"],

  credentialFields: [
    {
      name: "customerId",
      label: "Identifiant client OzonExpress",
      type: "text",
      required: true,
      help: "Fourni par OzonExpress à l'ouverture du compte marchand (parfois appelé « Customer ID » ou « N° de compte »).",
    },
    {
      name: "apiKey",
      label: "Clé API OzonExpress",
      type: "password",
      required: true,
      help: "Clé secrète associée à votre compte OzonExpress. Jamais réaffichée après enregistrement.",
    },
  ],

  /**
   * OzonExpress has no dedicated "ping / account" endpoint. The cheapest
   * safe authenticated call is a `tracking` lookup for a sentinel code:
   * valid credentials return a parseable body (even if it says the parcel
   * doesn't exist), while bad credentials return an auth error — which the
   * client turns into a typed DeliveryAuthError and this method lets
   * propagate. A "parcel not found" style response is treated as success:
   * it proves the credentials authenticated.
   */
  async testConnection(
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<DeliveryConnectionResult> {
    const creds = parseCredentials(credentials);
    const cfg = parseConfig(config);
    const client = new OzonExpressClient(creds, cfg.baseUrl, { timeoutMs: cfg.requestTimeoutMs });
    try {
      await client.post("tracking", { "tracking-number": "__connftest__" });
    } catch (error) {
      // A "not found" for the sentinel code still means auth worked.
      // Any auth / config / transport error is a real failure and
      // propagates unchanged (the service layer records ERREUR + lastError).
      if (error instanceof DeliveryNotFoundError) {
        return { ok: true };
      }
      throw error;
    }
    return { ok: true };
  },

  async createShipment(
    input: CreateShipmentAdapterInput,
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<CreateShipmentAdapterResult> {
    const creds = parseCredentials(credentials);
    const cfg = parseConfig(config);
    const client = new OzonExpressClient(creds, cfg.baseUrl, { timeoutMs: cfg.requestTimeoutMs });

    // buildAddParcelForm throws DeliveryConfigError for an unmapped city or
    // a negative COD BEFORE any network call.
    const form = buildAddParcelForm(input, cfg);
    const raw = await client.post("add-parcel", form);
    const parsed = parseAddParcelResponse(raw);

    return {
      externalId: parsed.externalId,
      trackingNumber: parsed.trackingNumber,
      // No per-parcel public tracking URL pattern is documented by
      // OzonExpress — never constructed by guessing (docs/adr/0012).
      trackingUrl: null,
      cost: parsed.cost,
      rawStatus: parsed.rawStatus,
    };
  },

  async fetchStatus(
    input: FetchStatusAdapterInput,
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<FetchStatusAdapterResult> {
    const creds = parseCredentials(credentials);
    const cfg = parseConfig(config);
    const client = new OzonExpressClient(creds, cfg.baseUrl, { timeoutMs: cfg.requestTimeoutMs });

    const raw = await client.post("tracking", { "tracking-number": input.externalId });
    const parsed = parseTrackingResponse(raw);
    return { rawStatus: parsed.rawStatus, trackingUrl: null, cost: parsed.cost };
  },

  mapStatus(rawStatus: string): ShipmentStatusValue | null {
    return mapOzonExpressStatus(rawStatus);
  },
};
