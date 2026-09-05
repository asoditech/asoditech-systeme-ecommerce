import "server-only";

import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";
import { validateShopDomain } from "./ssrf";
import { ShopifyClient } from "./client";
import type { Integration } from "@prisma/client";

interface StoredCredentials {
  apiKey?: string; // Admin API access token
  apiSecret?: string; // webhook signing secret
}

/**
 * Loads the single Shopify Integration row, decrypts its credentials, and
 * re-validates the shop domain — or `null` if nothing is configured yet
 * or the stored credentials are incomplete. Never throws: shared by the
 * manage-integration Server Actions (which turn `null` into their own
 * friendly actionError) AND by the automatic webhook/stock-push paths,
 * which must silently no-op rather than surface an error when the
 * operator simply hasn't connected Shopify (or has since disconnected it).
 */
export async function loadShopifyClient(): Promise<{ integration: Integration; client: ShopifyClient } | null> {
  const integration = await prisma.integration.findUnique({ where: { provider: "SHOPIFY" } });
  if (!integration || !integration.credentialsEncrypted) return null;

  const config = (integration.config as { shopDomain?: string } | null) ?? {};
  if (!config.shopDomain) return null;

  let credentials: StoredCredentials;
  try {
    credentials = JSON.parse(decryptSecret(integration.credentialsEncrypted));
  } catch {
    return null;
  }
  if (!credentials.apiKey) return null;

  const shopDomain = await validateShopDomain(config.shopDomain);
  const client = new ShopifyClient(shopDomain, credentials.apiKey);
  return { integration, client };
}
