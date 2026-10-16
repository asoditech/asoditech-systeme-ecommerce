import "server-only";

import { hasDeliveryProvider, registerDeliveryProvider } from "@/lib/integrations/delivery/registry";
import { ameexAdapter, AMEEX_PROVIDER_KEY } from "./adapter";

export {
  ameexAdapter,
  AMEEX_PROVIDER_KEY,
  AMEEX_VERIFICATION,
  AMEEX_BLOCKED_CAPABILITIES,
  AMEEX_SANDBOX_ONLY_NOTICE,
  AMEEX_WEBHOOK_TOPIC,
  AMEEX_WEBHOOK_SANDBOX_TOPIC,
} from "./adapter";
export { AmeexClient, AmeexRateLimiter, AMEEX_RATE_LIMIT_PER_MINUTE, type AmeexPostEncoding } from "./client";
export {
  AMEEX_SIGNATURE_HEADER,
  AMEEX_WEBHOOK_TOLERANCE_SECONDS,
  parseAmeexSignatureHeader,
  parseAmeexWebhook,
  readAmeexSignature,
  shouldIgnoreSandboxEvent,
  verifyAmeexSignature,
  webhookEventId,
  type AmeexWebhookPayload,
} from "./webhook";
export { AMEEX_BASE_URL, isSandboxKey, type AmeexCredentials, type AmeexConfig } from "./types";
export {
  AMEEX_STATUS_LABELS,
  AMEEX_STATUS_MAP,
  AMEEX_STATUS_MAPPING_STATUS,
  composeAmeexRawStatus,
  mapAmeexRawStatus,
  mapAmeexStatus,
} from "./status";

/**
 * Registers the Ameex adapter into the process-wide delivery registry.
 * Called by providers/index.ts (sandbox-verified 2026-10-16 — see
 * AMEEX_VERIFICATION; production not verified).
 *
 * Idempotent: a no-op if an "ameex" adapter is already registered.
 */
export function registerAmeexProvider(): void {
  if (hasDeliveryProvider(AMEEX_PROVIDER_KEY)) return;
  registerDeliveryProvider(ameexAdapter);
}
