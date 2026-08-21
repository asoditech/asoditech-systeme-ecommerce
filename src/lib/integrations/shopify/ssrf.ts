import "server-only";

import { assertPublicHost, InvalidHostError } from "@/lib/integrations/shared/private-ip";

export class InvalidShopDomainError extends Error {}

const MYSHOPIFY_SUFFIX = ".myshopify.com";

/**
 * Validates and normalizes a Shopify shop domain. Unlike WooCommerce
 * (an arbitrary self-hosted URL), a Shopify store's Admin API is only
 * ever reachable at its `<shop>.myshopify.com` domain — Shopify's own
 * guidance is to call the Admin API there even if the storefront also has
 * a connected custom domain. Requiring the exact `.myshopify.com` suffix
 * is therefore both correct per Shopify's API model AND an inherent SSRF
 * defense (that domain can never resolve to a private address) — the
 * shared DNS-resolution check below is still run for defense-in-depth and
 * consistency with the WooCommerce integration's pattern, not because a
 * genuine `myshopify.com` hostname could plausibly fail it.
 *
 * Accepts either a bare shop name ("mon-magasin"), a full domain
 * ("mon-magasin.myshopify.com"), or a full URL
 * ("https://mon-magasin.myshopify.com") and returns the normalized
 * `https://<shop>.myshopify.com` origin.
 */
export async function validateShopDomain(raw: string): Promise<string> {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    throw new InvalidShopDomainError("Le nom de la boutique Shopify est requis.");
  }

  let hostname: string;
  if (trimmed.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new InvalidShopDomainError("Adresse de boutique Shopify invalide.");
    }
    if (parsed.protocol !== "https:") {
      throw new InvalidShopDomainError("L'adresse de la boutique Shopify doit utiliser HTTPS.");
    }
    if (parsed.username || parsed.password) {
      throw new InvalidShopDomainError("L'adresse de la boutique ne doit pas contenir d'identifiants.");
    }
    hostname = parsed.hostname;
  } else {
    hostname = trimmed.includes(".") ? trimmed : `${trimmed}${MYSHOPIFY_SUFFIX}`;
  }

  if (!hostname.endsWith(MYSHOPIFY_SUFFIX) || hostname === MYSHOPIFY_SUFFIX.slice(1)) {
    throw new InvalidShopDomainError(
      "L'intégration Shopify n'accepte que le domaine *.myshopify.com de la boutique (pas un domaine personnalisé)."
    );
  }
  const shopName = hostname.slice(0, -MYSHOPIFY_SUFFIX.length);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(shopName)) {
    throw new InvalidShopDomainError("Nom de boutique Shopify invalide.");
  }

  try {
    await assertPublicHost(hostname);
  } catch (error) {
    if (error instanceof InvalidHostError) {
      throw new InvalidShopDomainError("Cette adresse de boutique Shopify n'est pas autorisée.");
    }
    throw error;
  }

  return `https://${hostname}`;
}
