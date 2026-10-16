import "server-only";

import {
  DeliveryConfigError,
  DeliveryMalformedResponseError,
  DeliveryOutcomeUnknownError,
  DeliveryProviderError,
} from "@/lib/integrations/delivery/errors";
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
  FetchTrackingAdapterResult,
  GenerateManifestAdapterInput,
  GenerateManifestAdapterResult,
} from "@/lib/integrations/delivery/types";
import type { ShipmentStatusValue } from "@/lib/validation/delivery";
import { OUTCOME_UNKNOWN_MESSAGE, OzonExpressClient } from "./client";

const MANIFEST_OUTCOME_UNKNOWN_MESSAGE =
  "OzonExpress n'a pas confirmé une étape du bon de livraison (pas de réponse ou erreur serveur). Le bon a peut-être été créé ou complété : vérifiez sur le portail OzonExpress avant d'en générer un nouveau.";
import {
  buildAddParcelForm,
  buildDeliveryNoteDocuments,
  mapOzonExpressStatus,
  parseAddParcelResponse,
  parseDeliveryNoteRef,
  parseOzonExpressCities,
  parseTrackingDetail,
  parseTrackingResponse,
  providerCityDeliveredPrice,
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
  capabilities: [
    "CREATE_SHIPMENT",
    "FETCH_STATUS",
    "FETCH_TRACKING",
    "FETCH_COST",
    "FETCH_CITIES",
    "GENERATE_MANIFEST",
  ],

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

    // Resolve the recipient city BEFORE creating the parcel — a typed
    // DeliveryConfigError here means no parcel is ever submitted.
    //   - `input.resolvedProviderCityId` set  → the generic mapping layer
    //     already resolved it (explicit DeliveryCityMapping, or a safe
    //     catalogue match); trust it verbatim.
    //   - null → fall back to the adapter's own `config.cityIdByName` +
    //     catalogue resolution, which throws rather than guessing.
    // The catalogue also carries the authoritative per-city delivery price.
    const catalogue = await fetchCities(client, cfg);
    const resolvedCityId = input.resolvedProviderCityId?.trim() || resolveCity(input.city, cfg, catalogue).id;
    const resolvedDeliveredPrice = providerCityDeliveredPrice(catalogue, resolvedCityId);
    const form = buildAddParcelForm(input, cfg, catalogue);
    // One attempt only — never retried (a retry after a lost response can
    // create a second parcel); an unknown outcome surfaces as
    // DeliveryOutcomeUnknownError and the shipment stays « à vérifier ».
    const raw = await client.post("add-parcel", form, { once: true });
    let parsed;
    try {
      parsed = parseAddParcelResponse(raw);
    } catch (error) {
      // OzonExpress accepted the request (no RESULT:ERROR) but the body
      // carries no usable parcel: it may still have been created.
      // Same for anything unexpected while reading an accepted answer.
      if (error instanceof DeliveryMalformedResponseError || !(error instanceof DeliveryProviderError)) {
        throw new DeliveryOutcomeUnknownError(OUTCOME_UNKNOWN_MESSAGE);
      }
      throw error;
    }

    return {
      externalId: parsed.externalId,
      trackingNumber: parsed.trackingNumber,
      // No per-parcel public tracking URL pattern is documented by
      // OzonExpress — never constructed by guessing (docs/adr/0012).
      trackingUrl: null,
      // The provider's own returned figure wins; otherwise the city's
      // authoritative DELIVERED-PRICE from the catalogue. Never a guess.
      cost: parsed.cost ?? resolvedDeliveredPrice,
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
   * « Suivi » module (docs/adr/0033) — the full event history from the
   * same `tracking` call `fetchStatus` uses. OzonExpress returns no
   * structured location, so that stays `null`. The courier (« livreur ») is
   * only SOMETIMES available: `parseTrackingDetail` (mapper.ts,
   * `courierFromTracking`) reads it when the response itself names one — a
   * courier-named field, or a history COMMENT that says « livreur » — and
   * returns `null` otherwise. The tracking service keeps a previously stored
   * courier when a later response omits it.
   */
  async fetchTracking(
    input: FetchStatusAdapterInput,
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<FetchTrackingAdapterResult> {
    const { client } = clientFor(credentials, config);
    const raw = await client.post("tracking", { "tracking-number": input.externalId });
    return parseTrackingDetail(raw);
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

    // Every step changes state at OzonExpress and none documents an
    // idempotency key: one attempt each, never retried (a retried
    // add-delivery-note can mint a second note — docs/adr/0015 « Deferred »).
    // An unknown outcome surfaces as DeliveryOutcomeUnknownError; the
    // caller marks the local manifest ECHEC with that message.
    let rawRef: unknown;
    try {
      rawRef = await client.post("add-delivery-note", {}, { once: true });
    } catch (error) {
      if (error instanceof DeliveryOutcomeUnknownError) throw new DeliveryOutcomeUnknownError(MANIFEST_OUTCOME_UNKNOWN_MESSAGE);
      throw error;
    }
    let ref: string;
    try {
      ref = parseDeliveryNoteRef(rawRef);
    } catch (error) {
      // Accepted (no RESULT:ERROR) but no readable ref: a note may exist.
      if (error instanceof DeliveryMalformedResponseError) throw new DeliveryOutcomeUnknownError(MANIFEST_OUTCOME_UNKNOWN_MESSAGE);
      throw error;
    }

    const addForm: Record<string, string> = { Ref: ref };
    input.externalIds.forEach((code, i) => {
      addForm[`Codes[${i}]`] = code;
    });
    try {
      await client.post("add-parcel-to-delivery-note", addForm, { once: true });
      await client.post("save-delivery-note", { Ref: ref }, { once: true });
    } catch (error) {
      // The note exists at OzonExpress from here on: name its reference so
      // the operator can find it on the portal (not a secret).
      if (error instanceof DeliveryOutcomeUnknownError) {
        throw new DeliveryOutcomeUnknownError(`${MANIFEST_OUTCOME_UNKNOWN_MESSAGE} Référence du bon chez OzonExpress : ${ref}.`);
      }
      throw error;
    }

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
