import "server-only";

import { z } from "zod";

/**
 * OzonExpress adapter — credential / config shapes and response schemas.
 *
 * Endpoints (path-based customer id + API key auth):
 *   POST /customers/{CUSTOMER_ID}/{API_KEY}/add-parcel
 *   POST /customers/{CUSTOMER_ID}/{API_KEY}/parcel-info
 *   POST /customers/{CUSTOMER_ID}/{API_KEY}/tracking
 *   GET  /cities                                  (catalogue — still unconfirmed)
 *
 * ✅ CONFIRMED against the live API (2026-09-01): the `tracking` response
 * envelope — `{ CHECK_API: {RESULT,MESSAGE}, TRACKING: {…, HISTORY:[…],
 * LAST_TRACKING:{STATUT,…}} }` — and that `CHECK_API.RESULT === "SUCCESS"`
 * with `MESSAGE === "Valide API Key"` is the authentication signal. Real
 * status vocabulary seen: "Nouveau Colis", "Attente De Ramassage",
 * "Ramassé", "Reçu", "Mise en distribution".
 *
 * ⚠️ STILL not confirmed live: the `add-parcel` request fields + response
 * envelope, the `parcel-info` envelope, `GET /cities`, and the full status
 * list (delivered / returned / refused / cancelled wording). Those schemas
 * stay defensively parsed. See docs/adr/0013-ozonexpress-integration.md.
 */

// ---------------------------------------------------------------------------
// Credentials & config
// ---------------------------------------------------------------------------

/**
 * Per-instance OzonExpress account credentials. Each ASODITECH deployment
 * (one client — see docs/adr/0002-domain-model.md) holds its own pair,
 * AES-256-GCM encrypted at rest on `ShippingProvider.credentialsEncrypted`
 * and never returned to the browser. `customerId` and `apiKey` are the two
 * values every known OzonExpress integration uses; both are placed in the
 * request PATH by the API (not a header), so this adapter's client treats
 * the whole URL as secret — see client.ts.
 */
export const ozonExpressCredentialsSchema = z.object({
  customerId: z.string().trim().min(1, "L'identifiant client OzonExpress est requis."),
  apiKey: z.string().trim().min(1, "La clé API OzonExpress est requise."),
});
export type OzonExpressCredentials = z.infer<typeof ozonExpressCredentialsSchema>;

/**
 * Non-secret per-instance configuration.
 *
 * `cityIdByName` — OPTIONAL override map ("our city name → OzonExpress
 * id"). The adapter's primary source is now the authoritative
 * `GET /cities` catalogue; this map only supplies corrections / aliases
 * for names the catalogue spells differently. Keys are compared
 * case-insensitively and trimmed. The adapter still refuses (typed
 * DeliveryConfigError) rather than guessing an id when neither source
 * resolves the recipient's city.
 *
 * `citiesPath` — path of the destination-catalogue endpoint. Defaults to
 * `"cities"` (`GET {baseUrl}/cities`), per the owner-provided
 * documentation. Escape hatch only.
 *
 * `stockMode` — OzonExpress `parcel-stock`: "ramassage" (0, carrier picks
 * the parcel up from the merchant) or "stock" (1, parcel already sits in
 * OzonExpress's warehouse). Defaults to "ramassage", the only mode that
 * works without pre-registering products with the carrier.
 *
 * `defaultParcelNature` — free-text contents description sent as
 * `parcel-nature` when an order has no better value.
 *
 * `requestTimeoutMs` — per-request timeout override (1–60 s). Optional;
 * defaults to the client's built-in 20 s.
 *
 * `baseUrl` — override only, for testing against a mock. Defaults to the
 * production host. Always re-validated for SSRF before every request.
 */
export const ozonExpressConfigSchema = z.object({
  cityIdByName: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  citiesPath: z.string().trim().min(1).max(200).optional(),
  stockMode: z.enum(["ramassage", "stock"]).optional(),
  defaultParcelNature: z.string().trim().max(120).optional(),
  requestTimeoutMs: z.number().int().min(1000).max(60_000).optional(),
  baseUrl: z.string().url().optional(),
});
export type OzonExpressConfig = z.infer<typeof ozonExpressConfigSchema>;

// ---------------------------------------------------------------------------
// API response schemas — deliberately permissive
// ---------------------------------------------------------------------------

/**
 * OzonExpress mixes flat and nested response envelopes and (per the
 * community integrations) sometimes returns an application error as an
 * HTTP 200 body. These schemas capture only what this adapter actually
 * reads and tolerate extra keys; the adapter's mapper is responsible for
 * pulling a value out of whichever place OzonExpress put it this time.
 */

/** An application-level error body: `{"RESULT":"ERROR","MESSAGE":"..."}`,
 * possibly nested one level under `ADD-PARCEL` / `TRACKING` / etc. */
export const ozonExpressErrorEnvelopeSchema = z
  .object({
    RESULT: z.string().optional(),
    MESSAGE: z.string().optional(),
  })
  .passthrough();

/** Fields the add-parcel success body is known to carry, in either the
 * flat form or nested under `ADD-PARCEL.NEW-PARCEL`. All optional — the
 * mapper validates that a tracking number was actually present. */
export const ozonExpressParcelBodySchema = z
  .object({
    "TRACKING-NUMBER": z.union([z.string(), z.number()]).optional(),
    RECEIVER: z.string().optional(),
    PHONE: z.union([z.string(), z.number()]).optional(),
    CITY_ID: z.union([z.string(), z.number()]).optional(),
    CITY_NAME: z.string().optional(),
    ADDRESS: z.string().optional(),
    PRICE: z.union([z.string(), z.number()]).optional(),
    // Carrier delivery fee that will apply IF the parcel is delivered.
    // This is the figure this adapter reports as the shipment cost — see
    // mapper.ts and docs/adr/0013 ("Delivery cost").
    "DELIVERED-PRICE": z.union([z.string(), z.number()]).optional(),
    "RETURNED-PRICE": z.union([z.string(), z.number()]).optional(),
    "REFUSED-PRICE": z.union([z.string(), z.number()]).optional(),
    STATUS: z.string().optional(),
  })
  .passthrough();

export const ozonExpressAddParcelResponseSchema = z
  .object({
    "TRACKING-NUMBER": z.union([z.string(), z.number()]).optional(),
    "ADD-PARCEL": z
      .object({
        RESULT: z.string().optional(),
        MESSAGE: z.string().optional(),
        "NEW-PARCEL": ozonExpressParcelBodySchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * `GET /cities` — the destination catalogue. Confirmed live (2026-09-01):
 * `{ CITIES: { "<id>": { ID, REF, NAME, "DELIVERED-PRICE",
 * "RETURNED-PRICE", "REFUSED-PRICE" } } }` — an object keyed by id. A bare
 * array and the alternate wrapper keys are also tolerated. The mapper
 * drops any entry missing an id or a name.
 */
export const ozonExpressCityEntrySchema = z
  .object({
    ID: z.union([z.string(), z.number()]).optional(),
    id: z.union([z.string(), z.number()]).optional(),
    CITY_ID: z.union([z.string(), z.number()]).optional(),
    REF: z.union([z.string(), z.number()]).optional(),
    ref: z.union([z.string(), z.number()]).optional(),
    NAME: z.string().optional(),
    name: z.string().optional(),
    CITY_NAME: z.string().optional(),
    ville: z.string().optional(),
    VILLE: z.string().optional(),
    "DELIVERED-PRICE": z.union([z.string(), z.number()]).optional(),
    "RETURNED-PRICE": z.union([z.string(), z.number()]).optional(),
    "REFUSED-PRICE": z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const cityListOrMap = z.union([
  z.array(ozonExpressCityEntrySchema),
  z.record(z.string(), ozonExpressCityEntrySchema),
]);

export const ozonExpressCitiesResponseSchema = z.union([
  z.array(ozonExpressCityEntrySchema),
  z
    .object({
      CITIES: cityListOrMap.optional(),
      cities: cityListOrMap.optional(),
      result: cityListOrMap.optional(),
      data: cityListOrMap.optional(),
    })
    .passthrough(),
]);

/**
 * `CHECK_API` — the auth-result block OzonExpress prepends to every
 * credentialed response. `RESULT: "SUCCESS"` + `MESSAGE: "Valide API Key"`
 * means the customer id / API key pair authenticated. This is the
 * connection-test signal (confirmed against the live API 2026-09-01).
 */
export const ozonExpressCheckApiSchema = z
  .object({ RESULT: z.string().optional(), MESSAGE: z.string().optional() })
  .passthrough();

/** One entry of `TRACKING.HISTORY` / the `TRACKING.LAST_TRACKING` block. */
export const ozonExpressTrackingEntrySchema = z
  .object({
    STATUT: z.string().optional(),
    STATUS: z.string().optional(),
    TIME: z.union([z.string(), z.number()]).optional(),
    TIME_STR: z.string().optional(),
    COMMENT: z.string().optional(),
  })
  .passthrough();

/**
 * Real `POST /customers/{id}/{key}/tracking` response (confirmed against
 * the live API 2026-09-01):
 *   { CHECK_API: {RESULT,MESSAGE},
 *     TRACKING: { "TRACKING-NUMBER", RESULT, MESSAGE,
 *                 HISTORY: [ {STATUT,TIME,TIME_STR,COMMENT}, … ],
 *                 LAST_TRACKING: {STATUT,TIME,TIME_STR,COMMENT} } }
 * HISTORY may deserialize as an array or as an object keyed "1","2",…
 * (PHP assoc-array). Older permissive fields kept as a fallback.
 */
export const ozonExpressTrackingResponseSchema = z
  .object({
    CHECK_API: ozonExpressCheckApiSchema.optional(),
    TRACKING: z
      .object({
        "TRACKING-NUMBER": z.union([z.string(), z.number()]).optional(),
        RESULT: z.string().optional(),
        MESSAGE: z.string().optional(),
        HISTORY: z
          .union([
            z.array(ozonExpressTrackingEntrySchema),
            z.record(z.string(), ozonExpressTrackingEntrySchema),
          ])
          .optional(),
        LAST_TRACKING: ozonExpressTrackingEntrySchema.optional(),
        "DELIVERED-PRICE": z.union([z.string(), z.number()]).optional(),
        "RETURNED-PRICE": z.union([z.string(), z.number()]).optional(),
        "REFUSED-PRICE": z.union([z.string(), z.number()]).optional(),
      })
      .passthrough()
      .optional(),
    // — legacy fallback fields (kept until every response variant is confirmed) —
    RESULT: z.string().optional(),
    MESSAGE: z.string().optional(),
    "TRACKING-NUMBER": z.union([z.string(), z.number()]).optional(),
    STATUS: z.string().optional(),
    "LAST-TRACKING": z
      .object({ STATUT: z.string().optional(), STATUS: z.string().optional() })
      .passthrough()
      .optional(),
    "DELIVERED-PRICE": z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();
