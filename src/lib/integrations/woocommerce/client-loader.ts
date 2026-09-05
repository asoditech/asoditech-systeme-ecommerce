import "server-only";

import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";
import { validateStoreUrl } from "./ssrf";
import { WooCommerceClient } from "./client";
import type { Integration } from "@prisma/client";

interface StoredCredentials {
  apiKey?: string;
  apiSecret?: string;
  webhookSecret?: string;
}

/**
 * Loads the single WooCommerce Integration row, decrypts its credentials,
 * and re-validates the store URL (DNS can change between save time and
 * now — see docs/adr/0010-woocommerce-integration.md) — or `null` if
 * nothing is configured yet or the stored credentials are incomplete.
 * Never throws: this is shared by the manage-integration Server Actions
 * (which turn `null` into their own friendly actionError) AND by the
 * automatic webhook/stock-push paths, which must silently no-op rather
 * than surface an error when the operator simply hasn't connected
 * WooCommerce (or has since disconnected it).
 */
export async function loadWooCommerceClient(): Promise<{ integration: Integration; client: WooCommerceClient } | null> {
  const integration = await prisma.integration.findUnique({ where: { provider: "WOOCOMMERCE" } });
  if (!integration || !integration.credentialsEncrypted) return null;

  const config = (integration.config as { siteUrl?: string } | null) ?? {};
  if (!config.siteUrl) return null;

  let credentials: StoredCredentials;
  try {
    credentials = JSON.parse(decryptSecret(integration.credentialsEncrypted));
  } catch {
    return null;
  }
  if (!credentials.apiKey || !credentials.apiSecret) return null;

  const storeUrl = await validateStoreUrl(config.siteUrl);
  const client = new WooCommerceClient(storeUrl, {
    consumerKey: credentials.apiKey,
    consumerSecret: credentials.apiSecret,
  });
  return { integration, client };
}
