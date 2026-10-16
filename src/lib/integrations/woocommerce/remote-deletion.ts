import "server-only";

import type { PrismaTransactionClient, prisma } from "@/lib/prisma";
import {
  applyRemoteProductCheck,
  clearRemoteMissingLink,
  flagRemoteMissingLink,
  pendingRemoteMissingOf,
  remoteLinkOfProduct,
  remoteLinksForExternalId,
  unlinkRemoteProduct,
  type RemoteActor,
  type RemoteDeletionResult,
  type RemoteMissingFlag,
  type RemoteProductCheck,
  type RemoteProductLink,
} from "@/lib/integrations/shared/remote-deletion";
import type { WooCommerceClient } from "./client";
import { WooCommerceNotFoundError } from "./errors";
import type { RemoteDeletionMode } from "./store-settings";

/**
 * A local product linked to a WooCommerce product that the store deleted.
 * The rule itself (links, flag, unlink, audit, notifications) is shared with
 * Shopify: src/lib/integrations/shared/remote-deletion.ts. This file keeps
 * what is WooCommerce-specific — the proof of deletion — and the
 * WooCommerce-bound entry points used by the webhook route and actions.
 *
 * What counts as a reliable deletion: the store itself answering
 * `GET /products/{id}` with 404 + WooCommerce's own `woocommerce_rest_product_invalid_id`.
 * A product in the store's trash is reversible, and every other answer
 * (timeout, network, 401/403, 429, 5xx, a 404 without that slug — wrong URL,
 * disabled REST API —, a malformed body) proves nothing: those only ever lead
 * to manual review, never to an automatic unlink.
 */

export const WOO_PRODUCT_INVALID_ID = "woocommerce_rest_product_invalid_id";

export type { RemoteActor, RemoteDeletionResult, RemoteMissingFlag, RemoteProductCheck };
export type WooProductLink = RemoteProductLink;

export async function checkWooCommerceProduct(client: WooCommerceClient | null, externalId: string): Promise<RemoteProductCheck> {
  if (!client || !/^\d+$/.test(externalId)) return "unknown";
  try {
    const product = await client.getProduct(Number(externalId));
    return product.status === "trash" ? "trashed" : "exists";
  } catch (error) {
    if (error instanceof WooCommerceNotFoundError && error.remoteCode === WOO_PRODUCT_INVALID_ID) return "deleted";
    return "unknown";
  }
}

/** Every local product linked to this WooCommerce product id (imported/adopted, or published). */
export const wooLinksForExternalId = (externalId: string) => remoteLinksForExternalId("WOOCOMMERCE", externalId);

/** This product's WooCommerce link, if any. */
export const wooLinkOfProduct = (productId: string) => remoteLinkOfProduct("WOOCOMMERCE", productId);

/** The pending « supprimé de la boutique » flag of this link, or null. */
export function pendingRemoteMissing(
  link: Pick<RemoteProductLink, "productId" | "externalId"> & { provider?: RemoteProductLink["provider"] },
  db?: PrismaTransactionClient | typeof prisma
): Promise<RemoteMissingFlag | null> {
  return pendingRemoteMissingOf({ provider: link.provider ?? "WOOCOMMERCE", productId: link.productId, externalId: link.externalId }, db);
}

export const flagRemoteMissing = flagRemoteMissingLink;
export const clearRemoteMissing = clearRemoteMissingLink;
export const unlinkWooProduct = unlinkRemoteProduct;
export const applyRemoteCheck = applyRemoteProductCheck;

/**
 * The store's signed `product.deleted` webhook (fired for a trashed or a
 * permanently deleted product): every local link to that id is checked
 * against the store once, then handled by the company's rule. With no usable
 * client (disconnected, bad credentials) the answer is `unknown` → flagged.
 */
export async function handleWooProductDeletedWebhook(
  externalId: string,
  client: WooCommerceClient | null,
  mode: RemoteDeletionMode
): Promise<{ productId: string; check: RemoteProductCheck; result: RemoteDeletionResult }[]> {
  const links = await wooLinksForExternalId(externalId);
  if (links.length === 0) return [];
  const check = await checkWooCommerceProduct(client, externalId);
  const outcomes = [];
  for (const link of links) {
    const result = await applyRemoteProductCheck(link, check, { mode, trigger: "webhook", actor: { type: "INTEGRATION" }, flagWhenUnknown: true });
    outcomes.push({ productId: link.productId, check, result });
  }
  return outcomes;
}
