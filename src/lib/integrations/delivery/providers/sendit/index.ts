import "server-only";

import { hasDeliveryProvider, registerDeliveryProvider } from "@/lib/integrations/delivery/registry";
import { senditAdapter, SENDIT_PROVIDER_KEY } from "./adapter";

/**
 * Sendit (Maroc) — HTTP client + DeliveryProviderAdapter built from the
 * official public spec (https://app.sendit.ma/docs/api-docs.json). Registered
 * in providers/index.ts so it is selectable for NEW API connections, with a
 * visible « pas encore validé sur un compte réel » notice. Every request /
 * response shape is verified only by stubbed-fetch unit tests. See
 * docs/carriers/sendit.md.
 */

export const SENDIT_VERIFICATION = "IMPLEMENTED_FROM_OFFICIAL_SPEC_NOT_LIVE_TESTED" as const;

/** What is still genuinely open after implementing from the official spec. */
export const SENDIT_OPEN_QUESTIONS: readonly string[] = [
  "Token lifetime / expiry (undocumented): cached 20 min, one re-login on 401.",
  "Rate limits (none documented) and whether a sandbox / test account exists.",
  "Required fields on POST /deliveries (none marked required) and accepted phone formats (only 06XXXXXXXX shown).",
  "Prepaid parcels: what `amount` must be when nothing is collected — prepaid orders are refused for now.",
  "printFormat values for POST /deliveries/getlabels (spec example: 1, used by default).",
  "DELETE /deliveries/{code} (« Supprimer un colis »): allowed statuses and cancel-vs-delete semantics — CANCEL not implemented.",
  "Status mapping review (PROVISIONAL_PENDING_OWNER_REVIEW), incl. which status_return values mean « retourné ».",
  "`products` field when Sendit stock is not used: free text accepted? length/format constraints?",
  "District `ville` vs `name` semantics in /districts, and whether pickup_district_id is mandatory on create.",
  "Order and timezone of `audits` / `last_action_at` (events kept in received order, no ISO timestamp).",
  "Whether 250/251/252 are real HTTP statuses or body codes (both are handled as definite refusals).",
];

export { senditAdapter, SENDIT_PROVIDER_KEY, SENDIT_NOT_VALIDATED_NOTICE } from "./adapter";
export { SenditClient, SENDIT_TOKEN_TTL_MS } from "./client";
export * from "./types";
export * from "./mapper";
export * from "./status";
export * from "./errors";

/** Registers the Sendit adapter. Idempotent (dev hot-reload). Registration
 * only makes it configurable: CONNECTE still requires a successful
 * « Tester la connexion » (a real POST /login). */
export function registerSenditProvider(): void {
  if (hasDeliveryProvider(SENDIT_PROVIDER_KEY)) return;
  registerDeliveryProvider(senditAdapter);
}
