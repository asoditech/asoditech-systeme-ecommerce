import "server-only";

import { DeliveryConfigError } from "@/lib/integrations/delivery/errors";
import type {
  CreateShipmentAdapterInput,
  CreateShipmentAdapterResult,
  DeliveryCity,
  DeliveryConnectionResult,
  DeliveryCredentials,
  DeliveryProviderAdapter,
  DeliveryProviderConfig,
  FetchStatusAdapterInput,
  FetchStatusAdapterResult,
  GenerateManifestAdapterInput,
  GenerateManifestAdapterResult,
} from "@/lib/integrations/delivery/types";
import type { ShipmentStatusValue } from "@/lib/validation/delivery";
import { OzonExpressClient } from "./client";
import {
  buildAddParcelForm,
  buildDeliveryNoteDocuments,
  mapOzonExpressStatus,
  parseAddParcelResponse,
  parseDeliveryNoteRef,
  parseOzonExpressCities,
  parseTrackingResponse,
  readCheckApiMessage,
  resolveCity,
  toDeliveryCities,
  type OzonExpressCity,
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
 *  ENDPOINTS OWNER-CONFIRMED · REQUEST/RESPONSE FIELDS NOT YET LIVE-TESTED
 * ═══════════════════════════════════════════════════════════════════════
 * Endpoints (path-based customer id + API key auth):
 *   POST /customers/{CUSTOMER_ID}/{API_KEY}/add-parcel   (CREATE_SHIPMENT)
 *   POST /customers/{CUSTOMER_ID}/{API_KEY}/tracking     (FETCH_STATUS + auth check)
 *   POST /customers/{CUSTOMER_ID}/{API_KEY}/parcel-info  (available, unused)
 *   GET  /cities   (or credentialed …/cities — path not yet confirmed)
 *
 * ✅ Confirmed live (2026-09-01): the `tracking` envelope and that
 * `CHECK_API.RESULT === "SUCCESS"` is the auth signal.
 *
 * Registered in production so the owner can configure credentials and run
 * "Tester la connexion". NOT auto-CONNECTE: saving credentials → CONFIGURE;
 * only a successful real connection test → CONNECTE.
 *
 * ⚠️ Still pending live confirmation: `add-parcel` fields + response,
 * `GET /cities`, and the delivered/returned/refused/cancelled status
 * wording. See docs/adr/0013-ozonexpress-integration.md.
 *
 * Capabilities: CREATE_SHIPMENT, FETCH_STATUS, FETCH_COST,
 * GENERATE_MANIFEST. No CANCEL_SHIPMENT (no endpoint) and no WEBHOOKS (no
 * callback) — attempts hit the shared typed "unsupported" error, never a
 * silent local action.
 *
 * ⚠️ GENERATE_MANIFEST (Bon de Livraison) endpoints — `add-delivery-note`
 * / `add-parcel-to-delivery-note` / `save-delivery-note` and the portal
 * PDF URLs — are owner-documented but NOT yet live-tested (2026-09-01).
 * Parsed defensively, same posture as `add-parcel`. See
 * docs/adr/0015-delivery-manifest.md.
 */

export const OZONEXPRESS_PROVIDER_KEY = "ozonexpress";

/**
 * Contract status:
 *  - "TRACKING_LIVE_VERIFIED" — the `tracking` endpoint, its `CHECK_API`
 *    auth signal, and the response envelope have been confirmed against a
 *    real OzonExpress account. `add-parcel` and `GET /cities` have not.
 */
export const OZONEXPRESS_VERIFICATION = "TRACKING_LIVE_VERIFIED" as const;

/** `GET /cities` catalogue path. Overridable via config. */
const DEFAULT_CITIES_PATH = "cities";

/**
 * Fetches the destination catalogue via the un-credentialed `GET /cities`
 * (confirmed live 2026-09-01). Returns `[]` on any failure — the caller
 * decides whether that is fatal.
 */
async function fetchCities(client: OzonExpressClient, cfg: OzonExpressConfig): Promise<OzonExpressCity[]> {
  try {
    return parseOzonExpressCities(await client.get(cfg.citiesPath ?? DEFAULT_CITIES_PATH));
  } catch {
    return [];
  }
}

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

function clientFor(credentials: DeliveryCredentials, config: DeliveryProviderConfig) {
  const creds = parseCredentials(credentials);
  const cfg = parseConfig(config);
  return { cfg, client: new OzonExpressClient(creds, cfg.baseUrl, { timeoutMs: cfg.requestTimeoutMs }) };
}

export const ozonExpressAdapter: DeliveryProviderAdapter = {
  key: OZONEXPRESS_PROVIDER_KEY,
  displayName: "OzonExpress (Maroc)",
  capabilities: ["CREATE_SHIPMENT", "FETCH_STATUS", "FETCH_COST", "GENERATE_MANIFEST"],

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
   * Safe verification path — "Tester la connexion" calls only this, and it
   * never creates a parcel.
   *
   * The credential check is a `POST tracking` with an empty tracking
   * number: OzonExpress answers with a `CHECK_API` block
   * (`{RESULT:"SUCCESS", MESSAGE:"Valide API Key"}` for a valid key). The
   * client's `assertNoApiError` already raises `DeliveryAuthError` from a
   * `CHECK_API.RESULT === "ERROR"`, so reaching this line means the key
   * authenticated; `CHECK_API.MESSAGE` is surfaced as a detail. The
   * `GET /cities` count is a best-effort extra (its exact path is not yet
   * confirmed) and never fails the test.
   */
  async testConnection(
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<DeliveryConnectionResult> {
    const { cfg, client } = clientFor(credentials, config);
    const details: Record<string, string | number> = {};

    // 1. Credential check — POST tracking with an empty code.
    const raw = await client.post("tracking", { "tracking-number": "" });
    const checkMessage = readCheckApiMessage(raw);
    details["authentification"] = checkMessage ?? "clé acceptée";

    // 2. Best-effort destination-catalogue count (GET /cities is confirmed).
    const cities = await fetchCities(client, cfg);
    if (cities.length > 0) details["villes desservies"] = cities.length;

    return { ok: true, details };
  },

  /** Retrieves OzonExpress's destination catalogue (`GET /cities`). Read-only. */
  async listCities(
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<DeliveryCity[]> {
    const { cfg, client } = clientFor(credentials, config);
    return toDeliveryCities(await fetchCities(client, cfg));
  },

  async createShipment(
    input: CreateShipmentAdapterInput,
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<CreateShipmentAdapterResult> {
    const { cfg, client } = clientFor(credentials, config);

    // Resolve the recipient city against the `GET /cities` catalogue
    // (config override wins) BEFORE creating the parcel — a typed
    // DeliveryConfigError here means no parcel is ever submitted. The
    // catalogue also carries the authoritative per-city delivery price.
    const catalogue = await fetchCities(client, cfg);
    const resolvedCity = resolveCity(input.city, cfg, catalogue);
    const form = buildAddParcelForm(input, cfg, catalogue);
    const raw = await client.post("add-parcel", form);
    const parsed = parseAddParcelResponse(raw);

    return {
      externalId: parsed.externalId,
      trackingNumber: parsed.trackingNumber,
      // No per-parcel public tracking URL pattern is documented by
      // OzonExpress — never constructed by guessing (docs/adr/0012).
      trackingUrl: null,
      // The provider's own returned figure wins; otherwise the city's
      // authoritative DELIVERED-PRICE from the catalogue. Never a guess.
      cost: parsed.cost ?? resolvedCity.deliveredPrice,
      rawStatus: parsed.rawStatus,
    };
  },

  async fetchStatus(
    input: FetchStatusAdapterInput,
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<FetchStatusAdapterResult> {
    const { client } = clientFor(credentials, config);
    const raw = await client.post("tracking", { "tracking-number": input.externalId });
    const parsed = parseTrackingResponse(raw);
    return { rawStatus: parsed.rawStatus, trackingUrl: null, cost: parsed.cost };
  },

  /**
   * Bon de Livraison, OzonExpress's 4-step handover flow:
   *   1. POST add-delivery-note              → { ref }
   *   2. POST add-parcel-to-delivery-note    Ref + Codes[i] = each tracking number
   *   3. POST save-delivery-note             Ref
   *   4. build the portal PDF URLs from the ref (operator opens them)
   *
   * The client's `assertNoApiError` turns an HTTP-200 `RESULT:ERROR` at
   * any step into a typed error, so a failure at step 2 or 3 (which
   * document no success body) still propagates. The local
   * `DeliveryManifest` row the caller created is then marked ECHEC and no
   * shipment is linked.
   */
  async generateManifest(
    input: GenerateManifestAdapterInput,
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<GenerateManifestAdapterResult> {
    const { cfg, client } = clientFor(credentials, config);

    const ref = parseDeliveryNoteRef(await client.post("add-delivery-note", {}));

    const addForm: Record<string, string> = { Ref: ref };
    input.externalIds.forEach((code, i) => {
      addForm[`Codes[${i}]`] = code;
    });
    await client.post("add-parcel-to-delivery-note", addForm);

    await client.post("save-delivery-note", { Ref: ref });

    return {
      externalRef: ref,
      // OzonExpress documents no confirmed count in the responses — never
      // inferred from input length (docs/adr/0012, docs/adr/0015).
      parcelCount: null,
      documents: buildDeliveryNoteDocuments(ref, cfg),
    };
  },

  mapStatus(rawStatus: string): ShipmentStatusValue | null {
    return mapOzonExpressStatus(rawStatus);
  },
};
