import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Generic base64(HMAC-SHA256(rawBody, secret)) verification — the exact
 * algorithm both WooCommerce (X-WC-Webhook-Signature) and Shopify
 * (X-Shopify-Hmac-SHA256) use for webhook delivery signing. Extracted
 * during Phase 21 so both providers share one audited implementation. See
 * docs/adr/0010-woocommerce-integration.md and
 * docs/adr/0011-shopify-integration.md.
 *
 * The caller must pass the untouched raw request body string (never a
 * re-serialized JSON.parse → JSON.stringify round trip, which can change
 * byte-for-byte formatting and break the comparison).
 */
export function verifyHmacSha256Base64(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");

  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signatureHeader, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/** Generates a new random shared secret (e.g. a webhook signing secret this system issues). */
export function generateSharedSecret(): string {
  return randomBytes(32).toString("hex");
}
