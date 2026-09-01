import "server-only";

import { z } from "zod";

/**
 * OzonExpress adapter — credential / config shapes and response schemas.
 *
 * ⚠️ UNVERIFIED CONTRACT. OzonExpress (ozonexpress.ma) publishes no
 * official merchant API documentation. Every endpoint, field name, and
 * response shape below was reconstructed by cross-referencing several
 * independent third-party integrations and is corroborated but NOT
 * confirmed by OzonExpress. See docs/adr/0013-ozonexpress-integration.md
 * ("API research") for the full provenance and the list of things that
 * are still unknown.
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
 * `cityIdByName` — OzonExpress's `add-parcel` requires a NUMERIC city id,
 * and there is no public authoritative city catalogue. This map is how an
 * operator declares "our city name → OzonExpress id"; the adapter looks
 * the recipient's city up here and refuses (typed DeliveryConfigError,
 * before any network call) rather than guessing an id if it is missing.
 * Keys are compared case-insensitively and trimmed.
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

/** tracking / parcel-info. The status lives under different keys across
 * observed responses; the mapper probes each. */
export const ozonExpressTrackingResponseSchema = z
  .object({
    RESULT: z.string().optional(),
    MESSAGE: z.string().optional(),
    "TRACKING-NUMBER": z.union([z.string(), z.number()]).optional(),
    STATUS: z.string().optional(),
    "LAST-TRACKING": z
      .object({ STATUT: z.string().optional(), STATUS: z.string().optional() })
      .passthrough()
      .optional(),
    TRACKING: z.unknown().optional(),
    "DELIVERED-PRICE": z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();
