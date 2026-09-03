import "server-only";

import { prisma } from "@/lib/prisma";
import { availableStockTotal } from "@/lib/inventory";
import type { WooCommerceClient } from "../client";
import { emptySyncSummary, recordNote, type SyncSummary } from "./types";

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
 * the storefront. This does not write anything to the internal database;
 * nothing here changed on our side, so no InventoryMovement is created.
 */
export async function pushStockToWooCommerce(client: WooCommerceClient): Promise<SyncSummary> {
  const summary = emptySyncSummary();

  const products = await prisma.product.findMany({
    where: { source: "WOOCOMMERCE", externalId: { not: null }, trackInventory: true },
    include: { inventoryItems: true, variations: { include: { inventoryItems: true } } },
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
        const sellable = availableStockTotal(variation.inventoryItems);
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

    const sellable = availableStockTotal(product.inventoryItems);
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
