import "server-only";

import { prisma } from "@/lib/prisma";
import { loadWooCommerceClient } from "@/lib/integrations/woocommerce/client-loader";
import { pushStockForWooCommerceOwner } from "@/lib/integrations/woocommerce/sync";
import { loadShopifyClient } from "@/lib/integrations/shopify/client-loader";
import { pushStockForShopifyOwner } from "@/lib/integrations/shopify/sync";

export interface StockChangeRefs {
  productIds?: (string | null | undefined)[];
  variationIds?: (string | null | undefined)[];
}

/**
 * After a LOCAL stock mutation (manual adjustment, order fulfillment/
 * cancellation/return, a stock transfer, a stocktake close-out), pushes
 * the new sellable stock for every affected WooCommerce/Shopify-linked
 * product/variation back to its store — so "Pousser le stock" and
 * "Synchroniser les produits" become recovery/reconciliation tools, not
 * the only way the storefront ever finds out about a local change.
 *
 * Same call convention as `checkAndNotifyLowStock` (product/variation ids,
 * not specific warehouse rows) — deliberately: WooCommerce has no
 * per-location stock concept at all, so its push always recomputes one
 * combined sellable number across every active-ENTREPOT location for the
 * owner regardless of which specific warehouse just changed (see
 * pushStockForWooCommerceOwner). Shopify does track stock per location,
 * so its push instead re-pushes every Shopify-linked location currently
 * holding this owner (see pushStockForShopifyOwner) — technically more
 * than the one location that changed when there's more than one, but
 * idempotent and cheap; precise enough without threading an exact
 * InventoryItem id through every stock-mutating code path in the app.
 *
 * Best-effort and silent: never throws, never blocks or delays the
 * caller's own action, and quietly no-ops for an INTERNE item or an
 * unconfigured/disconnected integration. Call this AFTER the triggering
 * transaction commits, exactly like checkAndNotifyLowStock.
 *
 * NEVER call this from the pull side of the sync (reconcileStockFromProvider,
 * importProduct, the inventory_levels/update webhook, …) — pushing back
 * what was just pulled FROM a store would immediately echo the change
 * back at it. The actual loop guard lives on the receiving end (see
 * reconcileStockFromProvider's `lastPushedQuantity` check); this
 * separation (pull call sites never call this at all) is the first line
 * of defense against ever looping.
 */
export async function pushStockAfterLocalChange(refs: StockChangeRefs): Promise<void> {
  try {
    const productIds = [...new Set((refs.productIds ?? []).filter((v): v is string => !!v))];
    const variationIds = [...new Set((refs.variationIds ?? []).filter((v): v is string => !!v))];
    if (productIds.length === 0 && variationIds.length === 0) return;

    const [products, variations] = await Promise.all([
      productIds.length > 0
        ? prisma.product.findMany({
            where: { id: { in: productIds }, source: { in: ["WOOCOMMERCE", "SHOPIFY"] }, externalId: { not: null } },
            select: { id: true, source: true },
          })
        : Promise.resolve([]),
      variationIds.length > 0
        ? prisma.productVariation.findMany({
            where: { id: { in: variationIds }, source: { in: ["WOOCOMMERCE", "SHOPIFY"] }, externalId: { not: null } },
            select: { id: true, source: true },
          })
        : Promise.resolve([]),
    ]);

    const wooOwners = [
      ...products.filter((p) => p.source === "WOOCOMMERCE").map((p) => ({ productId: p.id })),
      ...variations.filter((v) => v.source === "WOOCOMMERCE").map((v) => ({ variationId: v.id })),
    ];
    const shopifyOwners = [
      ...products.filter((p) => p.source === "SHOPIFY").map((p) => ({ productId: p.id })),
      ...variations.filter((v) => v.source === "SHOPIFY").map((v) => ({ variationId: v.id })),
    ];

    if (wooOwners.length > 0) {
      const loaded = await loadWooCommerceClient();
      if (loaded) {
        for (const owner of wooOwners) {
          await pushStockForWooCommerceOwner(loaded.client, owner);
        }
      }
    }

    if (shopifyOwners.length > 0) {
      const loaded = await loadShopifyClient();
      if (loaded) {
        for (const owner of shopifyOwners) {
          await pushStockForShopifyOwner(loaded.client, owner);
        }
      }
    }
  } catch (error) {
    console.error("pushStockAfterLocalChange() failed (non-fatal):", error);
  }
}
