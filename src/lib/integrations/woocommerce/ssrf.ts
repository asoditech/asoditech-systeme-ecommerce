import "server-only";

import { assertPublicHost, InvalidHostError } from "@/lib/integrations/shared/private-ip";

/**
 * Blocks the store URL from ever pointing at this server's own private
 * network. Checked both when credentials are saved AND immediately before
 * every outbound request (DNS can change between the two — a hostname that
 * resolved publicly at save time could later be re-pointed at an internal
 * address, "DNS rebinding"). See docs/adr/0010-woocommerce-integration.md.
 *
 * The IP-range/DNS-resolution logic itself is shared with the Shopify
 * integration (Phase 21) — see src/lib/integrations/shared/private-ip.ts.
 * This module keeps its own name/error type/URL-shape rules (HTTPS-only,
 * no embedded credentials) since those are WooCommerce-specific policy,
 * not generic SSRF logic.
 */
export class InvalidStoreUrlError extends Error {}

/**
 * Validates a store URL is well-formed, HTTPS, and does not currently
 * resolve to a private/loopback/link-local/reserved address. Returns the
 * normalized URL (origin only, no trailing slash) on success.
 *
 * HTTPS is required outright — WooCommerce's own docs say plain HTTP
 * requires OAuth 1.0a "one-legged" authentication instead of HTTP Basic
 * Auth to avoid credentials being intercepted; supporting that second auth
 * scheme for a rare self-hosted-over-HTTP case is deliberately out of scope
 * for this phase (see docs/adr/0010-woocommerce-integration.md).
 */
export async function validateStoreUrl(rawUrl: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new InvalidStoreUrlError("URL de boutique invalide.");
  }

  if (parsed.protocol !== "https:") {
    throw new InvalidStoreUrlError("L'URL de la boutique doit utiliser HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new InvalidStoreUrlError("L'URL de la boutique ne doit pas contenir d'identifiants.");
  }

  try {
    await assertPublicHost(parsed.hostname);
  } catch (error) {
    if (error instanceof InvalidHostError) {
      throw new InvalidStoreUrlError("Cette adresse de boutique n'est pas autorisée.");
    }
    throw error;
  }

  return `${parsed.protocol}//${parsed.host}`;
}
