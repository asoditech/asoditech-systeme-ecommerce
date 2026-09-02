import "server-only";

import { prisma } from "@/lib/prisma";
import type { RecordSource } from "@prisma/client";

/**
 * Product-definition boundary (Phase 28 —
 * docs/adr/0017-product-management-boundary.md): ASODITECH does not
 * duplicate WooCommerce/Shopify's own product editor. These two functions
 * are the only place external product-management URLs are built, from
 * trusted, already-validated data only:
 *   - `Integration.config.siteUrl` / `.shopDomain` — normalized HTTPS
 *     origins validated by `validateStoreUrl`/`validateShopDomain` at
 *     connect time (src/lib/integrations/{woocommerce,shopify}/ssrf.ts) —
 *     never a raw value from this request.
 *   - `Product.externalId` — the provider's own id, set only by that
 *     provider's own sync/import code, never client-supplied here.
 * There is no server-side fetch of these URLs (browser navigation only —
 * `<a href>`, never `dangerouslySetInnerHTML` or a redirect endpoint that
 * accepts a URL parameter, so there is no open-redirect surface at all)
 * and no user input is ever concatenated into one. A platform that isn't
 * genuinely CONNECTE (a real verified connection, not just saved
 * credentials — see docs/adr/0004) never produces a URL; every failure
 * path returns `null`, never a guessed link.
 */

function safeOrigin(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}

export interface ConnectedCommercePlatform {
  provider: "WOOCOMMERCE" | "SHOPIFY";
  label: string;
  /** Real admin "create a new product" URL — safe to render as `<a href>`. */
  createUrl: string;
}

/**
 * Every commerce platform with a real, verified connection right now —
 * what "Ajouter un produit" offers the operator instead of an
 * ASODITECH-native creation form.
 */
export async function getConnectedCommercePlatforms(): Promise<ConnectedCommercePlatform[]> {
  const integrations = await prisma.integration.findMany({
    where: { provider: { in: ["WOOCOMMERCE", "SHOPIFY"] }, status: "CONNECTE" },
  });

  const platforms: ConnectedCommercePlatform[] = [];
  for (const integration of integrations) {
    if (integration.provider === "WOOCOMMERCE") {
      const siteUrl = (integration.config as { siteUrl?: string } | null)?.siteUrl;
      const origin = siteUrl && safeOrigin(siteUrl);
      if (origin) {
        platforms.push({ provider: "WOOCOMMERCE", label: "WooCommerce", createUrl: `${origin}/wp-admin/post-new.php?post_type=product` });
      }
    } else if (integration.provider === "SHOPIFY") {
      const shopDomain = (integration.config as { shopDomain?: string } | null)?.shopDomain;
      const origin = shopDomain && safeOrigin(shopDomain);
      if (origin) {
        platforms.push({ provider: "SHOPIFY", label: "Shopify", createUrl: `${origin}/admin/products/new` });
      }
    }
  }
  return platforms;
}

/**
 * Resolves the real external admin edit URL for one already-imported
 * product, or `null` when it cannot be safely resolved — an internal
 * product (nothing external to link to), a missing/disconnected
 * integration, missing config, or a missing external id. Never fabricates
 * a URL from a partial state; the caller must show a clear "unavailable"
 * message on `null`, never fall back to a guess.
 */
export async function resolveExternalProductEditUrl(product: {
  source: RecordSource;
  externalId: string | null;
}): Promise<string | null> {
  if (!product.externalId) return null;

  if (product.source === "WOOCOMMERCE") {
    const integration = await prisma.integration.findUnique({ where: { provider: "WOOCOMMERCE" } });
    if (!integration || integration.status !== "CONNECTE") return null;
    const siteUrl = (integration.config as { siteUrl?: string } | null)?.siteUrl;
    const origin = siteUrl && safeOrigin(siteUrl);
    if (!origin) return null;
    return `${origin}/wp-admin/post.php?post=${encodeURIComponent(product.externalId)}&action=edit`;
  }

  if (product.source === "SHOPIFY") {
    const integration = await prisma.integration.findUnique({ where: { provider: "SHOPIFY" } });
    if (!integration || integration.status !== "CONNECTE") return null;
    const shopDomain = (integration.config as { shopDomain?: string } | null)?.shopDomain;
    const origin = shopDomain && safeOrigin(shopDomain);
    if (!origin) return null;
    // externalId is the full GraphQL gid ("gid://shopify/Product/123") —
    // the admin URL takes just the trailing numeric id.
    const numericId = product.externalId.split("/").pop();
    if (!numericId) return null;
    return `${origin}/admin/products/${encodeURIComponent(numericId)}`;
  }

  return null; // INTERNE — nothing external to link to
}
