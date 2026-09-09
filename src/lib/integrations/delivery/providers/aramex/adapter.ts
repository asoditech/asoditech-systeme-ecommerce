import "server-only";

import { DeliveryConfigError } from "@/lib/integrations/delivery/errors";
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
import { AramexClient } from "./client";
import {
  buildCalculateRatePayload,
  buildCreateShipmentPayload,
  mapAramexStatus,
  parseCalculateRateResponse,
  parseCreateShipmentResponse,
  parseTrackingResponse,
} from "./mapper";
import {
  aramexConfigSchema,
  aramexCredentialsSchema,
  type AramexConfig,
  type AramexCredentials,
} from "./types";

/**
 * Aramex delivery-provider adapter.
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  ENDPOINTS FROM OFFICIAL ARAMEX DOCS · NOT YET LIVE-TESTED
 * ═══════════════════════════════════════════════════════════════════════
 * JSON-over-HTTPS mirror of Aramex's SOAP Shipping API:
 *   POST …/Shipping/Service_1_0.svc/json/CreateShipments   (CREATE_SHIPMENT)
 *   POST …/Tracking/Service_1_0.svc/json/TrackShipments     (FETCH_STATUS + auth probe)
 *   POST …/RateCalculator/Service_1_0.svc/json/CalculateRate (FETCH_COST)
 * Auth: a `ClientInfo` block (UserName / Password / AccountNumber /
 * AccountPin / AccountEntity / AccountCountryCode) inside every request body.
 *
 * Registered in production so the owner can configure credentials + the
 * shipper address and run "Tester la connexion". NOT auto-CONNECTE: saving
 * credentials → CONFIGURE; only a successful real connection test → CONNECTE.
 *
 * Capabilities: CREATE_SHIPMENT, FETCH_STATUS, FETCH_COST. No
 * CANCEL_SHIPMENT (Aramex's cancel flow is pickup-scoped, not AWB-scoped),
 * no FETCH_CITIES (Aramex addresses by free-text city + ISO country, no
 * mandatory numeric city id), no GENERATE_MANIFEST, no WEBHOOKS (Aramex
 * push notifications require a separate provisioning we don't have).
 * Attempts at an undeclared capability hit the shared typed "unsupported"
 * error, never a silent local action.
 *
 * ⚠️ Request field names come from Aramex's official PHP sample
 * (`aramex/…/createShipmentsPHP.txt`); response parsing is defensive. The
 * tracking status vocabulary is a best-effort table pending a live call.
 * See docs/adr/0028-aramex-integration.md.
 */

export const ARAMEX_PROVIDER_KEY = "aramex";

/** Contract status — nothing here has touched a real Aramex account yet. */
export const ARAMEX_VERIFICATION = "NOT_LIVE_TESTED" as const;

/** An obviously-invalid waybill used only as a read-only auth probe in
 * `testConnection` — Aramex answers with `NonExistingWaybills` (creds OK)
 * or an auth notification (creds bad). Never a real shipment. */
const AUTH_PROBE_WAYBILL = "0000000000";

const CREATE_ENDPOINT = "Service_1_0.svc/json/CreateShipments";
const TRACK_ENDPOINT = "Service_1_0.svc/json/TrackShipments";
const RATE_ENDPOINT = "Service_1_0.svc/json/CalculateRate";

function parseCredentials(raw: DeliveryCredentials): AramexCredentials {
  const parsed = aramexCredentialsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DeliveryConfigError(
      "Identifiants Aramex incomplets — nom d'utilisateur, mot de passe, numéro de compte, code PIN, entité et code pays sont requis."
    );
  }
  return parsed.data;
}

function parseConfig(raw: DeliveryProviderConfig): AramexConfig {
  const parsed = aramexConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new DeliveryConfigError("Configuration du connecteur Aramex invalide.");
  }
  return parsed.data;
}

function clientFor(credentials: DeliveryCredentials, config: DeliveryProviderConfig) {
  const creds = parseCredentials(credentials);
  const cfg = parseConfig(config);
  return {
    creds,
    cfg,
    client: new AramexClient(creds, {
      timeoutMs: cfg.requestTimeoutMs,
      source: cfg.source,
      sandbox: cfg.sandbox,
      shippingBaseUrl: cfg.shippingBaseUrl,
      trackingBaseUrl: cfg.trackingBaseUrl,
      rateBaseUrl: cfg.rateBaseUrl,
    }),
  };
}

export const aramexAdapter: DeliveryProviderAdapter = {
  key: ARAMEX_PROVIDER_KEY,
  displayName: "Aramex",
  capabilities: ["CREATE_SHIPMENT", "FETCH_STATUS", "FETCH_COST"],

  credentialFields: [
    {
      name: "userName",
      label: "Nom d'utilisateur API Aramex",
      type: "text",
      required: true,
      help: "Adresse e-mail du compte Aramex activé pour l'API (demande « Aramex API tools »).",
    },
    {
      name: "password",
      label: "Mot de passe API Aramex",
      type: "password",
      required: true,
      help: "Mot de passe associé au compte API. Jamais réaffiché après enregistrement.",
    },
    {
      name: "accountNumber",
      label: "Numéro de compte Aramex",
      type: "text",
      required: true,
      help: "Numéro de compte marchand (ex. 20016).",
    },
    {
      name: "accountPin",
      label: "Code PIN du compte",
      type: "password",
      required: true,
      help: "Code PIN numérique fourni avec l'accès API — distinct du mot de passe du portail.",
    },
    {
      name: "accountEntity",
      label: "Entité (agence d'origine)",
      type: "text",
      required: true,
      help: "Code à 3 lettres de l'agence Aramex d'origine (ex. CMN pour Casablanca, AMM pour Amman).",
    },
    {
      name: "accountCountryCode",
      label: "Code pays du compte",
      type: "text",
      required: true,
      help: "Code pays ISO à 2 lettres du compte (ex. MA pour le Maroc).",
    },
  ],

  /**
   * Safe verification path — "Tester la connexion" calls only this, and it
   * creates nothing. A `TrackShipments` with one obviously-invalid waybill:
   * valid credentials return `HasErrors: false` + the waybill listed under
   * `NonExistingWaybills`; invalid credentials return `HasErrors: true`
   * with an authentication notification, which the client turns into a
   * typed `DeliveryAuthError`. Reaching the end here means the credentials
   * authenticated.
   */
  async testConnection(
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<DeliveryConnectionResult> {
    const { cfg, client } = clientFor(credentials, config);
    await client.post("tracking", TRACK_ENDPOINT, {
      Shipments: [AUTH_PROBE_WAYBILL],
      Transaction: { Reference1: "connection-test" },
      GetLastTrackingUpdateOnly: true,
    });

    const details: Record<string, string | number> = { authentification: "identifiants acceptés" };
    // Surface whether the shipper address is complete — a shipment can't be
    // created without it, and this is the moment the operator is looking.
    const shipperReady =
      Boolean(cfg.shipperName && cfg.shipperPhone && cfg.shipperLine1 && cfg.shipperCity);
    details["adresse d'expédition"] = shipperReady ? "configurée" : "à compléter";
    return { ok: true, details };
  },

  async createShipment(
    input: CreateShipmentAdapterInput,
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<CreateShipmentAdapterResult> {
    const { creds, cfg, client } = clientFor(credentials, config);

    const payload = buildCreateShipmentPayload({
      input,
      config: cfg,
      accountNumber: creds.accountNumber,
      accountCountryCode: creds.accountCountryCode,
    });
    const raw = await client.post("shipping", CREATE_ENDPOINT, payload);
    const parsed = parseCreateShipmentResponse(raw, cfg);

    // Aramex's CreateShipments response carries no price. Best-effort a
    // rate via CalculateRate — never fatal to a successful shipment.
    let cost: number | null = null;
    try {
      const rateRaw = await client.post(
        "rate",
        RATE_ENDPOINT,
        buildCalculateRatePayload({ input, config: cfg, accountCountryCode: creds.accountCountryCode })
      );
      cost = parseCalculateRateResponse(rateRaw);
    } catch {
      cost = null;
    }

    return {
      externalId: parsed.externalId,
      trackingNumber: parsed.trackingNumber,
      trackingUrl: parsed.trackingUrl,
      cost,
      rawStatus: parsed.rawStatus,
    };
  },

  async fetchStatus(
    input: FetchStatusAdapterInput,
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<FetchStatusAdapterResult> {
    const { cfg, client } = clientFor(credentials, config);
    const raw = await client.post("tracking", TRACK_ENDPOINT, {
      Shipments: [input.externalId],
      Transaction: { Reference1: "status-refresh" },
      GetLastTrackingUpdateOnly: false,
    });
    const parsed = parseTrackingResponse(raw, input.externalId, cfg);
    // Aramex tracking updates don't carry a shipping charge — never estimated.
    return { rawStatus: parsed.rawStatus, trackingUrl: parsed.trackingUrl, cost: null };
  },

  mapStatus(rawStatus: string): ShipmentStatusValue | null {
    return mapAramexStatus(rawStatus);
  },
};
