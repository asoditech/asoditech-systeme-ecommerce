import { z } from "zod";
import { registerDeliveryProvider, __resetDeliveryProviderRegistryForTests } from "@/lib/integrations/delivery/registry";
import {
  DeliveryAuthError,
  DeliveryConfigError,
  DeliveryMalformedResponseError,
  DeliveryNotFoundError,
  DeliveryTimeoutError,
  DeliveryUnavailableError,
} from "@/lib/integrations/delivery/errors";
import { assertPublicHost, InvalidHostError, verifyHmacSha256Base64 } from "@/lib/integrations/shared";
import type {
  CancelShipmentAdapterInput,
  CreateShipmentAdapterInput,
  CreateShipmentAdapterResult,
  DeliveryCity,
  DeliveryCredentials,
  DeliveryProviderAdapter,
  DeliveryProviderConfig,
  DeliveryWebhookEvent,
  FetchStatusAdapterInput,
  FetchStatusAdapterResult,
  GenerateManifestAdapterInput,
  GenerateManifestAdapterResult,
} from "@/lib/integrations/delivery/types";
import type { ShipmentStatusValue } from "@/lib/validation/delivery";

/**
 * A fixture delivery-provider adapter — NOT a real carrier. It exists only
 * to let the generic DeliveryProviderAdapter abstraction, the registry,
 * the Server Action layer, and the webhook plumbing be tested end-to-end
 * against the real test database (this repo's convention — see e.g.
 * tests/helpers/fake-woocommerce.ts), the same way a real carrier's
 * adapter eventually will be. It is registered only from test code (see
 * registerReferenceDeliveryProvider below) — never imported by
 * src/lib/integrations/delivery/providers/index.ts, so it can never reach
 * a production build. See docs/adr/0012-delivery-provider-integration.md,
 * "Provider selection" and "Test matrix".
 *
 * Its base URL defaults to https://example.com (a real, stable,
 * IANA-reserved-for-documentation domain, same convention as
 * fake-woocommerce.ts) so assertPublicHost's SSRF/DNS check passes for
 * real — only the actual HTTP request is intercepted via fetch mocking.
 */
export const REFERENCE_PROVIDER_KEY = "__test_reference__";
export const REFERENCE_BASE_URL = "https://example.com";
export const REFERENCE_WEBHOOK_TOPIC = "shipment.status_changed";

const credentialsSchema = z.object({ apiKey: z.string().min(1), webhookSecret: z.string().optional() });
const configSchema = z.object({ baseUrl: z.string().url().optional() });

const STATUS_MAP: Record<string, ShipmentStatusValue> = {
  created: "EN_ATTENTE",
  in_transit: "EN_TRANSIT",
  delivered: "LIVRE",
  failed: "ECHEC",
  returned: "RETOURNE",
  cancelled: "ANNULE",
};

const createResponseSchema = z.object({
  id: z.string().min(1),
  tracking_number: z.string().nullable(),
  tracking_url: z.string().nullable(),
  cost: z.number().nullable(),
  status: z.string(),
});

const statusResponseSchema = z.object({
  status: z.string(),
  tracking_url: z.string().nullable(),
  cost: z.number().nullable(),
});

const citiesResponseSchema = z.object({
  cities: z.array(z.object({ id: z.string(), name: z.string() })),
});

const manifestResponseSchema = z.object({
  ref: z.string().min(1),
  parcel_count: z.number().nullable().optional(),
  documents: z.array(z.object({ label: z.string(), url: z.string() })).optional(),
});

function parseCredentials(raw: DeliveryCredentials): { apiKey: string; webhookSecret?: string } {
  const parsed = credentialsSchema.safeParse(raw);
  if (!parsed.success) throw new DeliveryConfigError("Identifiants du connecteur de référence invalides.");
  return parsed.data;
}

function parseConfig(raw: DeliveryProviderConfig): { baseUrl: string } {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new DeliveryConfigError("Configuration du connecteur de référence invalide.");
  return { baseUrl: parsed.data.baseUrl ?? REFERENCE_BASE_URL };
}

async function request(baseUrl: string, path: string, apiKey: string, init?: RequestInit): Promise<unknown> {
  const url = new URL(path, baseUrl);
  try {
    await assertPublicHost(url.hostname);
  } catch (error) {
    if (error instanceof InvalidHostError) throw new DeliveryConfigError(error.message);
    throw error;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new DeliveryTimeoutError("Le connecteur de référence n'a pas répondu à temps.");
    }
    throw new DeliveryUnavailableError("Le connecteur de référence est indisponible.");
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) throw new DeliveryAuthError("Identifiants invalides.");
  if (response.status === 404) throw new DeliveryNotFoundError("Ressource introuvable.");
  if (response.status >= 500) throw new DeliveryUnavailableError("Le connecteur de référence est indisponible.");
  if (!response.ok) throw new DeliveryUnavailableError(`Erreur inattendue (${response.status}).`);

  try {
    return await response.json();
  } catch {
    throw new DeliveryMalformedResponseError("Réponse illisible du connecteur de référence.");
  }
}

export const referenceDeliveryProvider: DeliveryProviderAdapter = {
  key: REFERENCE_PROVIDER_KEY,
  displayName: "[TEST] Connecteur de référence",
  capabilities: [
    "CREATE_SHIPMENT",
    "CANCEL_SHIPMENT",
    "FETCH_STATUS",
    "FETCH_COST",
    "WEBHOOKS",
    "GENERATE_MANIFEST",
  ],

  async testConnection(credentials, config) {
    const { apiKey } = parseCredentials(credentials);
    const { baseUrl } = parseConfig(config);
    await request(baseUrl, "/account", apiKey);
    return { ok: true };
  },

  async listCities(credentials, config): Promise<DeliveryCity[]> {
    const { apiKey } = parseCredentials(credentials);
    const { baseUrl } = parseConfig(config);
    const raw = await request(baseUrl, "/cities", apiKey);
    const parsed = citiesResponseSchema.safeParse(raw);
    if (!parsed.success) throw new DeliveryMalformedResponseError("Réponse de catalogue de villes invalide.");
    return parsed.data.cities.map((c) => ({ id: c.id, name: c.name }));
  },

  async createShipment(input: CreateShipmentAdapterInput, credentials, config): Promise<CreateShipmentAdapterResult> {
    const { apiKey } = parseCredentials(credentials);
    const { baseUrl } = parseConfig(config);
    const raw = await request(baseUrl, "/shipments", apiKey, {
      method: "POST",
      body: JSON.stringify({ idempotency_key: input.localShipmentId, order_number: input.orderNumber }),
    });
    const parsed = createResponseSchema.safeParse(raw);
    if (!parsed.success) throw new DeliveryMalformedResponseError("Réponse de création d'expédition invalide.");
    return {
      externalId: parsed.data.id,
      trackingNumber: parsed.data.tracking_number,
      trackingUrl: parsed.data.tracking_url,
      cost: parsed.data.cost,
      rawStatus: parsed.data.status,
    };
  },

  async cancelShipment(input: CancelShipmentAdapterInput, credentials, config): Promise<void> {
    const { apiKey } = parseCredentials(credentials);
    const { baseUrl } = parseConfig(config);
    await request(baseUrl, `/shipments/${input.externalId}/cancel`, apiKey, { method: "POST" });
  },

  async fetchStatus(input: FetchStatusAdapterInput, credentials, config): Promise<FetchStatusAdapterResult> {
    const { apiKey } = parseCredentials(credentials);
    const { baseUrl } = parseConfig(config);
    const raw = await request(baseUrl, `/shipments/${input.externalId}`, apiKey);
    const parsed = statusResponseSchema.safeParse(raw);
    if (!parsed.success) throw new DeliveryMalformedResponseError("Réponse de statut invalide.");
    return { rawStatus: parsed.data.status, trackingUrl: parsed.data.tracking_url, cost: parsed.data.cost };
  },

  async generateManifest(
    input: GenerateManifestAdapterInput,
    credentials,
    config
  ): Promise<GenerateManifestAdapterResult> {
    const { apiKey } = parseCredentials(credentials);
    const { baseUrl } = parseConfig(config);
    const raw = await request(baseUrl, "/manifests", apiKey, {
      method: "POST",
      body: JSON.stringify({ codes: input.externalIds }),
    });
    const parsed = manifestResponseSchema.safeParse(raw);
    if (!parsed.success) throw new DeliveryMalformedResponseError("Réponse de bon de livraison invalide.");
    return {
      externalRef: parsed.data.ref,
      parcelCount: parsed.data.parcel_count ?? null,
      documents: (parsed.data.documents ?? []).filter((d) => {
        try {
          return new URL(d.url).protocol === "https:";
        } catch {
          return false;
        }
      }),
    };
  },

  mapStatus(rawStatus: string): ShipmentStatusValue | null {
    return STATUS_MAP[rawStatus] ?? null;
  },

  verifyWebhookSignature(rawBody: string, headers: Record<string, string>, secret: string): boolean {
    return verifyHmacSha256Base64(rawBody, headers["x-reference-signature"] ?? null, secret);
  },

  mapWebhookPayload(rawBody: string): DeliveryWebhookEvent | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const schema = z.object({
      delivery_id: z.string(),
      topic: z.string(),
      shipment_id: z.string().nullable(),
      status: z.string().nullable(),
    });
    const result = schema.safeParse(parsed);
    if (!result.success || result.data.topic !== REFERENCE_WEBHOOK_TOPIC) return null;
    return {
      deliveryId: result.data.delivery_id,
      topic: result.data.topic,
      externalId: result.data.shipment_id,
      rawStatus: result.data.status,
    };
  },
};

/** Call in a test's beforeEach — clears and re-registers just this fixture
 * adapter so tests don't leak registrations into each other. */
export function registerReferenceDeliveryProvider(): void {
  __resetDeliveryProviderRegistryForTests();
  registerDeliveryProvider(referenceDeliveryProvider);
}
