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
  DeliveryCapability,
  DeliveryCity,
  DeliveryConnectionResult,
  DeliveryCredentials,
  DeliveryProviderAdapter,
  DeliveryProviderConfig,
  DeliveryWebhookEvent,
  FetchStatusAdapterInput,
  FetchStatusAdapterResult,
  FetchTrackingAdapterResult,
} from "@/lib/integrations/delivery/types";
import type { ShipmentStatusValue } from "@/lib/validation/delivery";
import { AmeexClient, type AmeexClientOptions } from "./client";
import { AMEEX_OUTCOME_UNKNOWN_MESSAGE } from "./errors";
import {
  ameexEventRawStatus,
  ameexEventTimestamp,
  assertAmeexEnvelope,
  buildAmeexAddParcelForm,
  countAmeexStatuses,
  latestAmeexEvent,
  parseAmeexAddParcelCode,
  parseAmeexCities,
  parseAmeexTracking,
  toAdapterTrackingEvent,
} from "./mapper";
import { composeAmeexRawStatus, mapAmeexRawStatus } from "./status";
import {
  AMEEX_PATHS,
  ameexConfigSchema,
  ameexCredentialsSchema,
  isSandboxKey,
  type AmeexConfig,
  type AmeexCredentials,
} from "./types";
import { parseAmeexWebhook, readAmeexSignature, verifyAmeexSignature, webhookEventId } from "./webhook";

/**
 * Ameex (Maroc) delivery-provider adapter.
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  SANDBOX-VERIFIED 2026-10-16 · PRODUCTION NOT VERIFIED · REGISTERED
 * ═══════════════════════════════════════════════════════════════════════
 * Every request/response shape used here was observed on the Ameex sandbox
 * (`test_` key) on 2026-10-16 — tests/fixtures/ameex/sandbox-responses-2026-10-16.json:
 *   GET  /Delivery/Parcels/Statuts                 testConnection
 *   GET  /Delivery/Cities                          FETCH_CITIES
 *   POST /Delivery/Parcels/Action/Type/Add (FORM)  CREATE_SHIPMENT (one attempt)
 *   GET  /Delivery/Parcels/Tracking/ParcelCode/{c} FETCH_STATUS / FETCH_TRACKING
 *   webhook (form + HMAC)                          WEBHOOKS → re-fetch via FETCH_STATUS
 * Business errors arrive as HTTP 200 + `api.type: "error"` (handled by
 * assertAmeexEnvelope). Status mapping is PROVISIONAL (./status.ts); the
 * raw status is always kept.
 *
 * Still BLOCKED (undocumented) — see AMEEX_BLOCKED_CAPABILITIES.
 */

export const AMEEX_PROVIDER_KEY = "ameex";

/** Sandbox only — no production key has been tested. */
export const AMEEX_VERIFICATION = "SANDBOX_VERIFIED_2026_10_16" as const;

/** Visible honesty note in the « Configurer » dialog. */
export const AMEEX_SANDBOX_ONLY_NOTICE =
  "Connecteur Ameex validé sur le bac à sable Ameex uniquement — pas encore sur un compte de production. Statuts : correspondance provisoire.";

/** Topic labels (Ameex names no topics — these are ours). A sandbox event
 * keeps its own topic so callers can tell it apart from the generic event. */
export const AMEEX_WEBHOOK_TOPIC = "ameex.parcel.status";
export const AMEEX_WEBHOOK_SANDBOX_TOPIC = "ameex.parcel.status.sandbox";

export interface AmeexBlockedCapability {
  capability: DeliveryCapability | "MASS_TRACKING";
  reason: string;
}

/** What is still NOT implemented, and exactly why. */
export const AMEEX_BLOCKED_CAPABILITIES: readonly AmeexBlockedCapability[] = [
  {
    capability: "CANCEL_SHIPMENT",
    reason: "Aucun point de terminaison d'annulation documenté.",
  },
  {
    capability: "GENERATE_MANIFEST",
    reason: "Aucun point de terminaison de bordereau documenté.",
  },
  {
    capability: "FETCH_LABEL",
    reason: "Aucun point de terminaison d'étiquette documenté.",
  },
  {
    capability: "FETCH_COST",
    reason: "Aucun tarif documenté ; la réponse de création ne renvoie aucun frais.",
  },
  {
    capability: "MASS_TRACKING",
    reason:
      "MassTracking / MassInfo observés sur le bac à sable, mais le contrat d'adaptateur n'a pas d'opération groupée : non branchés.",
  },
];

function parseCredentials(raw: DeliveryCredentials): AmeexCredentials {
  const parsed = ameexCredentialsSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new DeliveryConfigError(
      "Identifiants Ameex incomplets — l'identifiant API (C-Api-Id) et la clé API (C-Api-Key) sont requis."
    );
  }
  return parsed.data;
}

function parseConfig(raw: DeliveryProviderConfig): AmeexConfig {
  const parsed = ameexConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new DeliveryConfigError("Configuration du connecteur Ameex invalide.");
  }
  return parsed.data;
}

/** Test seam: lets tests inject a limiter / sleep. Never set in production. */
let clientOptionsOverride: Omit<AmeexClientOptions, "timeoutMs"> | null = null;
export function __setAmeexClientOptionsForTests(options: Omit<AmeexClientOptions, "timeoutMs"> | null): void {
  clientOptionsOverride = options;
}

function clientFor(credentials: DeliveryCredentials, config: DeliveryProviderConfig) {
  const creds = parseCredentials(credentials);
  const cfg = parseConfig(config);
  return {
    creds,
    client: new AmeexClient(creds, { ...(clientOptionsOverride ?? {}), timeoutMs: cfg.requestTimeoutMs }),
  };
}

async function fetchTrackingEvents(client: AmeexClient, externalId: string) {
  const code = externalId.trim();
  if (!code) throw new DeliveryConfigError("Code de colis Ameex manquant.");
  const raw = await client.get(`${AMEEX_PATHS.TRACKING}${encodeURIComponent(code)}`);
  return parseAmeexTracking(assertAmeexEnvelope(raw));
}

export const ameexAdapter: DeliveryProviderAdapter = {
  key: AMEEX_PROVIDER_KEY,
  displayName: "Ameex (Maroc)",
  capabilities: ["CREATE_SHIPMENT", "FETCH_STATUS", "FETCH_TRACKING", "FETCH_CITIES", "WEBHOOKS"],
  acceptsNewConnections: true,
  notice: AMEEX_SANDBOX_ONLY_NOTICE,

  credentialFields: [
    {
      name: "apiId",
      label: "Identifiant API Ameex (API Id)",
      type: "text",
      required: true,
      help: "Dans votre espace Ameex : « Développeur / API ». Envoyé à Ameex dans l'en-tête C-Api-Id.",
    },
    {
      name: "apiKey",
      label: "Clé API Ameex (API Key)",
      type: "password",
      required: true,
      help: "Dans « Développeur / API ». Une clé commençant par « test_ » utilise le bac à sable Ameex (colis fictifs) ; toute autre clé utilise la production. Jamais réaffichée après enregistrement.",
    },
    {
      name: "webhookSecret",
      label: "Secret de signature des webhooks Ameex",
      type: "password",
      required: false,
      help: "Le même secret que celui configuré chez Ameex pour le webhook. Sans lui, Ameex envoie des webhooks non signés, qui sont TOUJOURS refusés : les mises à jour automatiques de statut ne fonctionneront pas (le rafraîchissement manuel reste possible).",
    },
  ],

  /**
   * One authenticated read: GET /Delivery/Parcels/Statuts. Success = the
   * documented envelope (`login: "success"`, `api.type: "success"`) with a
   * status catalogue. `login` ≠ success / 401 / 403 → DeliveryAuthError.
   * Creates nothing at Ameex.
   */
  async testConnection(
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<DeliveryConnectionResult> {
    const { creds, client } = clientFor(credentials, config);
    const api = assertAmeexEnvelope(await client.get(AMEEX_PATHS.STATUTS));
    const statuses = countAmeexStatuses(api);
    return { ok: true, details: { mode: isSandboxKey(creds.apiKey) ? "sandbox" : "production", statuts: statuses } };
  },

  /** GET /Delivery/Cities — `api.cities` keyed by numeric id. */
  async listCities(credentials: DeliveryCredentials, config: DeliveryProviderConfig): Promise<DeliveryCity[]> {
    const { client } = clientFor(credentials, config);
    return parseAmeexCities(assertAmeexEnvelope(await client.get(AMEEX_PATHS.CITIES)));
  },

  /**
   * POST Add, form-encoded (the sandbox refused JSON), exactly ONE attempt.
   *  - bad city id / COD → DeliveryConfigError before anything is sent;
   *  - `api.type: "error"` → definite refusal (DeliveryConfigError);
   *  - timeout / 5xx / 429 / unreadable or code-less success →
   *    DeliveryOutcomeUnknownError (the parcel may exist: « à vérifier »).
   */
  async createShipment(
    input: CreateShipmentAdapterInput,
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<CreateShipmentAdapterResult> {
    const { client } = clientFor(credentials, config);
    const form = buildAmeexAddParcelForm(input, input.resolvedProviderCityId);

    const raw = await client.postOnce(AMEEX_PATHS.ADD_PARCEL, form, "form");
    let code: string;
    try {
      code = parseAmeexAddParcelCode(assertAmeexEnvelope(raw));
    } catch (error) {
      // Unreadable / code-less success, or anything unexpected after the
      // request was sent: the parcel may exist. Only a typed refusal from
      // the documented error envelope (`api.type: "error"`, sandbox-observed)
      // or an auth failure stays definite.
      if (error instanceof DeliveryMalformedResponseError || !(error instanceof DeliveryProviderError)) {
        throw new DeliveryOutcomeUnknownError(AMEEX_OUTCOME_UNKNOWN_MESSAGE);
      }
      throw error;
    }
    return {
      externalId: code,
      trackingNumber: code,
      // No public tracking URL pattern is documented — never guessed.
      trackingUrl: null,
      // The Add response carries no fee.
      cost: null,
      // The Add response carries no status (the parcel starts NEW_PARCEL on
      // the sandbox, read back by the first status sync).
      rawStatus: null,
    };
  },

  /** Latest tracking event (by `sorting_time`) → raw status. */
  async fetchStatus(
    input: FetchStatusAdapterInput,
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<FetchStatusAdapterResult> {
    const { client } = clientFor(credentials, config);
    const latest = latestAmeexEvent(await fetchTrackingEvents(client, input.externalId));
    return { rawStatus: ameexEventRawStatus(latest), trackingUrl: null, cost: null };
  },

  async fetchTracking(
    input: FetchStatusAdapterInput,
    credentials: DeliveryCredentials,
    config: DeliveryProviderConfig
  ): Promise<FetchTrackingAdapterResult> {
    const { client } = clientFor(credentials, config);
    const events = await fetchTrackingEvents(client, input.externalId);
    const latest = latestAmeexEvent(events);
    return {
      rawStatus: ameexEventRawStatus(latest),
      events: events.map(toAdapterTrackingEvent),
      // Ameex's tracking names no courier / location.
      courier: null,
      location: null,
      lastUpdateAt: ameexEventTimestamp(latest),
    };
  },

  /** PROVISIONAL mapping — see ./status.ts. Unknown → null (raw kept). */
  mapStatus(rawStatus: string): ShipmentStatusValue | null {
    return mapAmeexRawStatus(rawStatus);
  },

  verifyWebhookSignature(rawBody: string, headers: Record<string, string>, secret: string): boolean {
    return verifyAmeexSignature(rawBody, headers, secret);
  },

  /**
   * Maps an already-verified delivery. `deliveryId` = sha256(`${t}.${rawBody}`)
   * (the signed timestamp + exact body), `externalId` = CODE (the Ameex parcel
   * code), `rawStatus` = STATUT[/STATUT_S]. Returns null when the signature header (for
   * `t`) or CODE / STATUT is missing. A sandbox event gets
   * AMEEX_WEBHOOK_SANDBOX_TOPIC — the caller must still apply
   * `shouldIgnoreSandboxEvent` with the configured key (this method cannot
   * see credentials).
   */
  mapWebhookPayload(rawBody: string, headers: Record<string, string>): DeliveryWebhookEvent | null {
    const sig = readAmeexSignature(headers);
    if (!sig) return null;
    const payload = parseAmeexWebhook(rawBody);
    if (!payload) return null;
    return {
      deliveryId: webhookEventId(rawBody, sig.t),
      topic: payload.sandbox ? AMEEX_WEBHOOK_SANDBOX_TOPIC : AMEEX_WEBHOOK_TOPIC,
      externalId: payload.parcelCode,
      // Same composition as the tracking read ("IN_PROGRESS/NO_ANSWER").
      // Informational only: handleDeliveryWebhook re-fetches the status
      // authoritatively through fetchStatus.
      rawStatus: composeAmeexRawStatus(payload.status, payload.subStatus?.code ?? null),
    };
  },

  /** A sandbox event (SANDBOX=1) on a live key is never processed. */
  shouldIgnoreWebhookEvent(event: DeliveryWebhookEvent, credentials: DeliveryCredentials): string | null {
    const apiKey = typeof credentials.apiKey === "string" ? credentials.apiKey : "";
    if (event.topic === AMEEX_WEBHOOK_SANDBOX_TOPIC && !isSandboxKey(apiKey)) {
      return "Évènement sandbox Ameex reçu sur une clé de production — ignoré.";
    }
    return null;
  },
};
