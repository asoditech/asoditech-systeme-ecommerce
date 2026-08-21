import "server-only";

import { prisma } from "@/lib/prisma";
import type { ShopifyClient } from "../client";
import { emptySyncSummary, recordNote, type SyncSummary } from "@/lib/integrations/shared";

const BATCH_SIZE = 25;

/**
 * System → Shopify (the "push" half — see docs/adr/0011-shopify-integration.md).
 * Unlike WooCommerce (one global stock number per product), Shopify
 * tracks inventory per-location — this pushes one (inventoryItemId,
 * locationId, quantity) entry per (product/variation, Shopify-sourced
 * warehouse) pair that actually has an InventoryItem row, not a single
 * collapsed number. Only Shopify-linked products/variations, at
 * Shopify-linked warehouses, are ever pushed to.
 *
 * The pushed quantity is *sellable* stock (`quantityOnHand -
 * quantityReserved`), matching the WooCommerce integration's same
 * reasoning — units already reserved against a local order must not
 * appear purchasable on the storefront. This never writes to the internal
 * database — nothing changed on our side, so no InventoryMovement is
 * created.
 */
export async function pushStockToShopify(client: ShopifyClient): Promise<SyncSummary> {
  const summary = emptySyncSummary();

  const shopifyWarehouses = await prisma.warehouse.findMany({ where: { source: "SHOPIFY", externalId: { not: null } } });
  const warehouseIds = new Set(shopifyWarehouses.map((w) => w.id));
  const warehouseExternalId = new Map(shopifyWarehouses.map((w) => [w.id, w.externalId!]));

  const items = await prisma.inventoryItem.findMany({
    where: { warehouseId: { in: [...warehouseIds] } },
    include: {
      product: true,
      variation: true,
    },
  });

  const entries: { inventoryItemId: string; locationId: string; quantity: number }[] = [];

  for (const item of items) {
    const owner = item.variation ?? item.product;
    // Push only where this InventoryItem row itself carries Shopify's own
    // InventoryItem gid (captured during the pull sync — see
    // sync/products.ts) — that gid, not the Product/Variant gid, is what
    // the inventorySetQuantities mutation targets.
    if (!owner || owner.source !== "SHOPIFY" || !item.externalId) {
      summary.skipped++;
      continue;
    }
    entries.push({
      inventoryItemId: item.externalId,
      locationId: warehouseExternalId.get(item.warehouseId)!,
      quantity: Math.max(0, item.quantityOnHand - item.quantityReserved),
    });
  }

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    try {
      await client.setInventoryQuantities(batch);
      summary.updated += batch.length;
    } catch {
      recordNote(summary, `Lot de stock Shopify (${batch.length} article(s)) : échec de l'envoi.`);
      summary.failed += batch.length;
    }
  }

  return summary;
}
