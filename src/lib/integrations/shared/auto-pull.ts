import "server-only";

import { prisma } from "@/lib/prisma";
import { loadWooCommerceClient } from "@/lib/integrations/woocommerce/client-loader";
import { pullStockForWooCommerceOwner } from "@/lib/integrations/woocommerce/sync";
import { loadShopifyClient } from "@/lib/integrations/shopify/client-loader";
import { pullStockForShopifyOwner } from "@/lib/integrations/shopify/sync";
import type { SyncActor } from "./actor";
import type { StockChangeRefs } from "./auto-push";

/**
 * Targeted PROVIDER → System stock refresh for exactly the product/
 * variation lines of ONE order — called right before this app releases a
 * WooCommerce/Shopify order's reservation at EXPEDIEE
 * (`updateOrderStatusAction`), so `quantityOnHand` reflects the
 * provider's real, already-happened stock reduction before "Disponible"
 * is computed with the reservation gone. Without this, releasing the
 * reservation on a stale `quantityOnHand` briefly reports the order's
 * units as fully available again — order #15627, docs/adr/0030's
 * addendum.
 *
 * This is NOT the broad, automatic product-webhook pull disabled by
 * `516e393` (that incident's fix — the `reconcileStock` gate on
 * `syncOneProduct`/`syncOneVariation` — is untouched by this function).
 * It never runs from an arbitrary incoming webhook and never touches any
 * product/variation beyond the exact lines of the order that triggered
 * it. It only ever reads from the provider (`getProduct`/
 * `getProductVariation` — no `updateStock`/`setInventoryQuantities`
 * call), so it cannot push anything back and cannot create a push/pull
 * loop with the automatic push already disabled for provider orders (see
 * docs/adr/0030's #15623 addendum).
 *
 * Best-effort and silent: never throws. A provider outage or missing
 * integration here must never block shipping the order in ASODITECH
 * itself — worst case, `quantityOnHand` stays exactly as stale as it was
 * before this call, same as today without a manual "Synchroniser".
 */
export async function pullStockBeforeReservationRelease(refs: StockChangeRefs, actor: SyncActor): Promise<void> {
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
          await pullStockForWooCommerceOwner(loaded.client, owner, actor);
        }
      }
    }

    if (shopifyOwners.length > 0) {
      const loaded = await loadShopifyClient();
      if (loaded) {
        for (const owner of shopifyOwners) {
          await pullStockForShopifyOwner(loaded.client, owner, actor);
        }
      }
    }
  } catch (error) {
    console.error("pullStockBeforeReservationRelease() failed (non-fatal):", error);
  }
}
