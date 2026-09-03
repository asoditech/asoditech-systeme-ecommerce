import "server-only";

import { prisma } from "@/lib/prisma";
import { availableStockTotal } from "@/lib/inventory";
import type { WooCommerceClient } from "../client";
import { emptySyncSummary, recordNote, type SyncSummary } from "./types";

type ItemWithWarehouse = {
  quantityOnHand: number;
  quantityReserved: number;
  warehouse: { type: "ENTREPOT" | "MAGASIN"; isActive: boolean };
};

/**
 * Sellable stock to publish to the online storefront (Phase 32b business
 * rule — docs/adr/0020-stock-transfers.md §10): ONLY active-ENTREPOT
 * inventory feeds WooCommerce; MAGASIN stock never does.
 *
 *  - no InventoryItem row at all → `null` → caller skips the push
 *    (preserve pre-32b behaviour for untracked products).
 *  - has inventory rows but zero active-ENTREPOT stock (everything is at a
 *    MAGASIN, or only at an inactive/retired ENTREPOT) → `0`, pushed so the
 *    storefront quantity goes to 0 instead of staying stale.
 *  - otherwise → sellable units summed across the active ENTREPOTs.
 */
function onlineSellableStock(items: ItemWithWarehouse[]): number | null {
  if (items.length === 0) return null;
  const entrepot = items.filter((i) => i.warehouse.type === "ENTREPOT" && i.warehouse.isActive);
  return availableStockTotal(entrepot) ?? 0;
}

/**
 * System → WooCommerce (the "push" half — see docs/adr/0010-woocommerce-integration.md).
 * Only ever targets products/variations already linked to WooCommerce
 * (source=WOOCOMMERCE with a real externalId) — pushing a purely internal
 * product's stock to WooCommerce would require guessing which external
 * product it corresponds to, which this phase never does.
 *
 * The pushed quantity is *sellable* stock (`quantityOnHand -
 * quantityReserved`), never raw `quantityOnHand` — units already reserved
 * against a local order are spoken for and must not appear purchasable on
 * the storefront — and, since Phase 32b, restricted to active-ENTREPOT
 * locations (see onlineSellableStock). This does not write anything to the
 * internal database; nothing here changed on our side, so no
 * InventoryMovement is created.
 */
export async function pushStockToWooCommerce(client: WooCommerceClient): Promise<SyncSummary> {
  const summary = emptySyncSummary();

  const itemInclude = { include: { warehouse: { select: { type: true, isActive: true } } } } as const;
  const products = await prisma.product.findMany({
    where: { source: "WOOCOMMERCE", externalId: { not: null }, trackInventory: true },
    include: {
      inventoryItems: itemInclude,
      variations: { include: { inventoryItems: itemInclude } },
    },
  });

  for (const product of products) {
    const wcProductId = Number(product.externalId);
    if (!Number.isFinite(wcProductId)) {
      recordNote(summary, `Produit ${product.sku} : identifiant WooCommerce invalide.`);
      summary.skipped++;
      continue;
    }

    if (product.variations.length > 0) {
      for (const variation of product.variations) {
        if (variation.source !== "WOOCOMMERCE" || !variation.externalId) {
          summary.skipped++;
          continue;
        }
        const wcVariationId = Number(variation.externalId);
        const sellable = onlineSellableStock(variation.inventoryItems);
        if (sellable == null) {
          summary.skipped++;
          continue;
        }
        try {
          await client.updateStock(wcProductId, sellable, wcVariationId);
          summary.updated++;
        } catch {
          recordNote(summary, `Variation ${variation.sku} : échec de l'envoi du stock à WooCommerce.`);
          summary.failed++;
        }
      }
      continue;
    }

    const sellable = onlineSellableStock(product.inventoryItems);
    if (sellable == null) {
      summary.skipped++;
      continue;
    }
    try {
      await client.updateStock(wcProductId, sellable);
      summary.updated++;
    } catch {
      recordNote(summary, `Produit ${product.sku} : échec de l'envoi du stock à WooCommerce.`);
      summary.failed++;
    }
  }

  return summary;
}
