import "server-only";

import { z } from "zod";

/**
 * Ameex (Maroc) adapter — credential / config shapes.
 *
 * Documented contract (confirmed on the Ameex SANDBOX on 2026-10-16;
 * production not verified):
 *   Base URL   https://api.ameex.app/customer
 *   Auth       headers `C-Api-Id` (customer id) + `C-Api-Key` (key) on
 *              every request. A key starting with `test_` targets the
 *              sandbox at the SAME URLs; any other key is production.
 *   Rate limit 60 calls / minute.
 *
 * Response shapes observed on the sandbox are parsed in ./mapper.ts
 * (fixture: tests/fixtures/ameex/sandbox-responses-2026-10-16.json). See
 * docs/carriers/ameex.md.
 */

/** Optional string that treats "" (an empty, not-required UI field) as absent. */
const optionalSecret = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined));

/**
 * Per-tenant Ameex credentials, AES-256-GCM encrypted at rest on
 * `ShippingProvider.credentialsEncrypted` like every other carrier and
 * never returned to the browser.
 *
 * `webhookSecret` — the signing secret configured on the Ameex side. When
 * it is absent Ameex sends UNSIGNED webhooks; our policy is to REJECT every
 * unsigned delivery (handleDeliveryWebhook already refuses a provider row
 * without `webhookSecret`).
 */
export const ameexCredentialsSchema = z.object({
  apiId: z.string().trim().min(1, "L'identifiant API Ameex (C-Api-Id) est requis."),
  apiKey: z.string().trim().min(1, "La clé API Ameex (C-Api-Key) est requise."),
  webhookSecret: optionalSecret,
});
export type AmeexCredentials = z.infer<typeof ameexCredentialsSchema>;

/**
 * Non-secret per-tenant configuration. Deliberately NO base-URL override:
 * the base URL is fixed (`AMEEX_BASE_URL`), so a tenant can never point the
 * credential-carrying client at another host.
 */
export const ameexConfigSchema = z.object({
  requestTimeoutMs: z.number().int().min(1_000).max(60_000).optional(),
});
export type AmeexConfig = z.infer<typeof ameexConfigSchema>;

export const AMEEX_BASE_URL = "https://api.ameex.app/customer";

/** Documented: a key starting with `test_` targets the sandbox (same URLs). */
export function isSandboxKey(apiKey: string): boolean {
  return apiKey.trim().startsWith("test_");
}

/** Documented paths (relative to AMEEX_BASE_URL). MASS_TRACKING / MASS_INFO
 * (form field `codes`) are not called: the adapter contract has no bulk
 * operation. */
export const AMEEX_PATHS = {
  STATUTS: "/Delivery/Parcels/Statuts",
  CITIES: "/Delivery/Cities",
  ADD_PARCEL: "/Delivery/Parcels/Action/Type/Add",
  TRACKING: "/Delivery/Parcels/Tracking/ParcelCode/", // + encodeURIComponent(code)
  MASS_TRACKING: "/Delivery/Parcels/MassTracking",
  MASS_INFO: "/Delivery/Parcels/MassInfo",
} as const;
