import "server-only";

import {
  applyRemoteProductCheck,
  archiveForRemote,
  remoteLinksForExternalId,
  type RemoteDeletionResult,
  type RemoteProductCheck,
} from "@/lib/integrations/shared/remote-deletion";
import type { RemoteDeletionMode } from "@/lib/integrations/woocommerce/store-settings";
import type { ShopifyClient } from "./client";

/**
 * Shopify side of the shared remote-deletion rule
 * (src/lib/integrations/shared/remote-deletion.ts) — same modes, same
 * flag / unlink / audit / notifications as WooCommerce.
 *
 * Shopify has no trash: `productDelete` is irreversible (Admin GraphQL
 * 2026-07), and the signed `products/delete` webhook carries only `{ id }`.
 * What counts as a reliable deletion: Shopify itself answering
 * `product(id:)` with `null` and no error. ARCHIVED / DRAFT products still
 * exist — they are a deactivation (mapped to ARCHIVE / BROUILLON by the
 * sync), never a deletion, never an unlink. Every other answer (timeout,
 * network, 401/403, THROTTLED/429, 5xx, a GraphQL error, a malformed body,
 * a malformed id) proves nothing → `unknown` → manual review only.
 */

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;

export async function checkShopifyProduct(client: Pick<ShopifyClient, "getProductStatus"> | null, gid: string): Promise<RemoteProductCheck> {
  if (!client || !PRODUCT_GID.test(gid)) return "unknown";
  try {
    return (await client.getProductStatus(gid)) === null ? "deleted" : "exists";
  } catch {
    return "unknown";
  }
}

export interface ShopifyDeletionOutcome {
  productId: string;
  check: RemoteProductCheck;
  result: RemoteDeletionResult;
  archived: boolean;
}

/**
 * The signed `products/delete` webhook: checked against Shopify once, then
 * for every local link to that gid —
 * - a product imported from Shopify (source SHOPIFY) is archived locally
 *   (reason `deleted_upstream`, never deleted: its orders, stock movements,
 *   refunds and audit keep their link) unless Shopify proves it still exists;
 * - the link itself follows the company's rule (auto: unlinked on a
 *   confirmed deletion only; manual / unverifiable: flagged for review).
 * An ASODITECH product merely published to Shopify keeps its own status.
 * Idempotent: a repeated delivery archives nothing twice, flags once.
 */
export async function handleShopifyProductDeletedWebhook(
  gid: string,
  client: Pick<ShopifyClient, "getProductStatus"> | null,
  mode: RemoteDeletionMode
): Promise<ShopifyDeletionOutcome[]> {
  const links = await remoteLinksForExternalId("SHOPIFY", gid);
  if (links.length === 0) return [];
  const check = await checkShopifyProduct(client, gid);
  const outcomes: ShopifyDeletionOutcome[] = [];
  for (const link of links) {
    const archived = link.kind === "imported" && check !== "exists" ? await archiveForRemote(link.productId, "SHOPIFY", "deleted_upstream") : false;
    const result = await applyRemoteProductCheck(link, check, { mode, trigger: "webhook", actor: { type: "INTEGRATION" }, flagWhenUnknown: true });
    outcomes.push({ productId: link.productId, check, result, archived });
  }
  return outcomes;
}
