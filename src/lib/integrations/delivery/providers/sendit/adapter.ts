import "server-only";

import {
  DeliveryConfigError,
  DeliveryMalformedResponseError,
  DeliveryOutcomeUnknownError,
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
} from "@/lib/integrations/delivery/types";
import type { ShipmentStatusValue } from "@/lib/validation/delivery";
import { SenditClient, type SenditClientOptions } from "./client";
import { SENDIT_OUTCOME_UNKNOWN_MESSAGE, senditUnconfirmedCreateRefusal } from "./errors";
import {
  assertEnvelopeSuccess,
  buildCreateDeliveryBody,
  parseDeliveryDetail,
  parseDeliveryTracking,
  parseDistricts,
  parseLabelsResponse,
  toDeliveryCities,
  type SenditDeliveryDetail,
  type SenditDistrict,
} from "./mapper";
import { composeSenditRawStatus, mapSenditRawStatus } from "./status";
import {
  senditConfigSchema,
  senditCredentialsSchema,
  senditEnvelopeSchema,
  type SenditConfig,
  type SenditCredentials,
} from "./types";

/**
 * Sendit (Maroc) delivery-provider adapter.
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  IMPLEMENTED FROM THE OFFICIAL SPEC · NOT YET VALIDATED ON A REAL ACCOUNT
 * ═══════════════════════════════════════════════════════════════════════
 * Source: https://app.sendit.ma/docs/api-docs.json (+ owner's Swagger export).
 *   POST /login                    testConnection (login only — creates nothing)
 *   POST /deliveries               CREATE_SHIPMENT (+ FETCH_COST: `fee`)
 *   GET  /deliveries/{code}        FETCH_STATUS / FETCH_TRACKING (`audits`)
 *   GET  /districts?page=N         FETCH_CITIES (paginated)
 *   POST /deliveries/getlabels     FETCH_LABEL (signed https link, never stored)
 *
 * Not declared:
 *  - CANCEL_SHIPMENT: DELETE /deliveries/{code} is documented only as
 *    « Supprimer un colis » — which statuses allow it, and whether it is a
 *    cancellation or a hard delete, is not documented.
 *  - WEBHOOKS: Sendit documents none.
 *  - GENERATE_MANIFEST: no handover-note endpoint in the scope used here.
 *
 * Status mapping is PROVISIONAL (./status.ts); the raw `status` (and
 * `status_return`) is always kept verbatim.
 */

export const SENDIT_PROVIDER_KEY = "sendit";

/** Visible honesty note — same posture as the former Aramex guide. */
export const SENDIT_NOT_VALIDATED_NOTICE = "Connecteur Sendit disponible mais pas encore validé sur un compte réel.";

/** Hard cap on GET /districts pages (spec example: 10 per page). */
const MAX_DISTRICT_PAGES = 200;

let clientOptionsForTests: SenditClientOptions | null = null;
/** Tests only — e.g. a no-op backoff sleep. */
export function __setSenditClientOptionsForTests(options: SenditClientOptions | null): void {
  clientOptionsForTests = options;
}

function parseCredentials(raw: DeliveryCredentials): SenditCredentials {
  const parsed = senditCredentialsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DeliveryConfigError("Identifiants Sendit incomplets — la clé publique et la clé secrète sont requises.");
  }
  return parsed.data;
}

function parseConfig(raw: DeliveryProviderConfig): SenditConfig {
  const parsed = senditConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new DeliveryConfigError("Configuration du connecteur Sendit invalide.");
  }
  return parsed.data;
}

function clientFor(credentials: DeliveryCredentials, config: DeliveryProviderConfig) {
  const creds = parseCredentials(credentials);
  const cfg = parseConfig(config);
  return { cfg, client: new SenditClient(creds, clientOptionsForTests ?? {}) };
}

function rawStatusOf(detail: SenditDeliveryDetail): string {
  if (!detail.status) throw new DeliveryMalformedResponseError("Réponse Sendit sans statut de colis.");
  return composeSenditRawStatus(detail.status, detail.statusReturn);
}

async function fetchAllDistricts(client: SenditClient, cfg: SenditConfig): Promise<SenditDistrict[]> {
  const all: SenditDistrict[] = [];
  for (let page = 1; page <= MAX_DISTRICT_PAGES; page++) {
    const raw = await client.get("districts", { page, "pickup-district": cfg.pickupDistrictId });
    const { districts, pagination } = parseDistricts(raw);
    all.push(...districts);
    const more =
      pagination.lastPage !== null ? page < pagination.lastPage : pagination.hasNextPage && districts.length > 0;
    if (!more) break;
  }
  return all;
}

export const senditAdapter: DeliveryProviderAdapter = {
  key: SENDIT_PROVIDER_KEY,
  displayName: "Sendit (Maroc)",
  capabilities: ["CREATE_SHIPMENT", "FETCH_STATUS", "FETCH_TRACKING", "FETCH_COST", "FETCH_CITIES", "FETCH_LABEL"],
  acceptsNewConnections: true,
  notice: SENDIT_NOT_VALIDATED_NOTICE,

  credentialFields: [
    {
      name: "publicKey",
      label: "Clé publique Sendit (public_key)",
      type: "text",
      required: true,
      help: "Disponible dans votre compte Sendit, rubrique API / Intégrations.",
    },
    {
      name: "secretKey",
      label: "Clé secrète Sendit (secret_key)",
      type: "password",
      required: true,
      help: "Clé secrète associée à votre compte Sendit. Jamais réaffichée après enregistrement.",
    },
  ],

  /** POST /login only — proves the keys work; creates nothing at Sendit. */
  async testConnection(credentials: DeliveryCredentials, config: DeliveryProviderConfig): Promise<DeliveryConnectionResult> {
    const { client } = clientFor(credentials, config);
    await client.token({ force: true });
    return { ok: true, details: { authentification: "clés acceptées" } };
  },

  async listCities(credentials: DeliveryCredentials, config: DeliveryProviderConfig): Promise<DeliveryCity[]> {
    const { cfg, client } = clientFor(credentials, config);
    return toDeliveryCities(await fetchAllDistricts(client, cfg));
  },

  async createShipment(
    input: CreateShipmentAdapterInput,
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<CreateShipmentAdapterResult> {
    const { cfg, client } = clientFor(credentials, config);

    // Everything below is checked BEFORE any request: a typed config error
    // here means nothing was sent to Sendit.
    const districtId = input.resolvedProviderCityId?.trim();
    if (!districtId) {
      throw new DeliveryConfigError(
        "Ville non reconnue chez Sendit — ajoutez une correspondance de villes pour ce prestataire, puis réessayez."
      );
    }
    // `amount` = « Montant total de colis ». What a prepaid parcel must
    // declare is undocumented, so only cash-on-delivery orders are sent.
    if (input.codAmount === null) {
      throw new DeliveryConfigError(
        "Sendit : seules les commandes en paiement à la livraison peuvent être envoyées pour l'instant (montant d'un colis prépayé non documenté)."
      );
    }
    const body = buildCreateDeliveryBody(input, cfg, districtId, { amount: input.codAmount });

    // ONE attempt — never retried; an uncertain outcome surfaces as
    // DeliveryOutcomeUnknownError and the shipment stays « à vérifier ».
    const raw = await client.createOnce("deliveries", { ...body });
    // `success: false` in a 2xx body is NOT a documented create answer
    // (spec: 200 success / 250 / 251 / 252 / 422 / 403 / 500) — it does not
    // prove nothing was created → outcome unknown, never ECHEC.
    const envelope = senditEnvelopeSchema.safeParse(raw);
    if (envelope.success && envelope.data.success === false) {
      throw senditUnconfirmedCreateRefusal(envelope.data.message, client.secrets());
    }
    let detail: SenditDeliveryDetail;
    try {
      detail = parseDeliveryDetail(raw);
    } catch (error) {
      // Accepted but unreadable / no parcel code (or anything unexpected
      // after the request was sent): it may still exist.
      if (error instanceof DeliveryOutcomeUnknownError) throw error;
      throw new DeliveryOutcomeUnknownError(SENDIT_OUTCOME_UNKNOWN_MESSAGE);
    }

    return {
      externalId: detail.code,
      trackingNumber: detail.code,
      // No public tracking URL pattern is documented — never guessed.
      trackingUrl: null,
      cost: detail.fee,
      rawStatus: detail.status ? composeSenditRawStatus(detail.status, detail.statusReturn) : null,
    };
  },

  async fetchStatus(
    input: FetchStatusAdapterInput,
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<FetchStatusAdapterResult> {
    const { client } = clientFor(credentials, config);
    const raw = await client.get(`deliveries/${encodeURIComponent(input.externalId)}`);
    assertEnvelopeSuccess(raw, client.secrets());
    const detail = parseDeliveryDetail(raw);
    return { rawStatus: rawStatusOf(detail), trackingUrl: null, cost: detail.fee };
  },

  async fetchTracking(
    input: FetchStatusAdapterInput,
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<FetchTrackingAdapterResult> {
    const { client } = clientFor(credentials, config);
    const raw = await client.get(`deliveries/${encodeURIComponent(input.externalId)}`);
    assertEnvelopeSuccess(raw, client.secrets());
    const { detail, events } = parseDeliveryTracking(raw);
    return {
      rawStatus: rawStatusOf(detail),
      events,
      courier: null,
      location: null,
      // `last_action_at` has no documented timezone — not converted to ISO.
      lastUpdateAt: null,
    };
  },

  /**
   * POST /deliveries/getlabels for ONE parcel → signed https `fileUrl`,
   * returned on demand and never stored. Falls back to the parcel's own
   * signed `labelUrl` (GET /deliveries/{code}) when getlabels returns no
   * usable https link.
   */
  async fetchLabel(
    input: FetchStatusAdapterInput,
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<{ url: string }> {
    const { cfg, client } = clientFor(credentials, config);
    const raw = await client.postRead("deliveries/getlabels", {
      codesToPrint: input.externalId,
      printFormat: cfg.labelPrintFormat ?? 1,
    });
    assertEnvelopeSuccess(raw, client.secrets());
    try {
      return { url: parseLabelsResponse(raw) };
    } catch (error) {
      if (!(error instanceof DeliveryMalformedResponseError)) throw error;
    }
    const detailRaw = await client.get(`deliveries/${encodeURIComponent(input.externalId)}`);
    assertEnvelopeSuccess(detailRaw, client.secrets());
    const detail = parseDeliveryDetail(detailRaw);
    if (!detail.labelUrl) {
      throw new DeliveryMalformedResponseError("Sendit n'a renvoyé aucun lien d'étiquette valide (HTTPS sur app.sendit.ma requis).");
    }
    return { url: detail.labelUrl };
  },

  /** PROVISIONAL mapping — see ./status.ts. Unknown → null (raw kept). */
  mapStatus(rawStatus: string): ShipmentStatusValue | null {
    return mapSenditRawStatus(rawStatus);
  },
};
