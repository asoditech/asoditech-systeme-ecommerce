import "server-only";

import { verifyHmacSha256Base64, generateSharedSecret } from "@/lib/integrations/shared/hmac";

/**
 * Verifies a WooCommerce webhook delivery signature.
 *
 * Confirmed from WooCommerce core source (class-wc-webhook.php,
 * generate_signature()) during Phase 20 rather than assumed:
 *   base64_encode(hash_hmac('sha256', $payload, $secret, true))
 * where $payload is the exact raw request body WooCommerce sent — so the
 * caller must pass the untouched raw body string. The actual crypto is
 * shared with Shopify (Phase 21) — see
 * src/lib/integrations/shared/hmac.ts.
 */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  return verifyHmacSha256Base64(rawBody, signatureHeader, secret);
}

/** Generates a new random webhook secret for the operator to paste into WooCommerce admin. */
export function generateWebhookSecret(): string {
  return generateSharedSecret();
}
