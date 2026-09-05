import "server-only";

import { prisma } from "@/lib/prisma";
import { availableStock } from "@/lib/inventory";
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
      quantity: availableStock(item),
    });
  }

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    try {
      await client.setInventoryQuantities(batch);
      summary.updated += batch.length;
      await recordPushedQuantities(batch);
    } catch {
      recordNote(summary, `Lot de stock Shopify (${batch.length} article(s)) : échec de l'envoi.`);
      summary.failed += batch.length;
    }
  }

  return summary;
}

/** Stamps the echo-loop guard (see reconcileStockFromProvider) on every
 * InventoryItem row just pushed. Best-effort: a failure here must not
 * fail the push itself, which already happened. */
async function recordPushedQuantities(
  entries: { inventoryItemId: string; locationId: string; quantity: number }[]
): Promise<void> {
  try {
    await Promise.all(
      entries.map((e) =>
        prisma.inventoryItem.updateMany({
          where: { externalId: e.inventoryItemId },
          data: { lastPushedQuantity: e.quantity, lastPushedAt: new Date() },
        })
      )
    );
  } catch (error) {
    console.error("recordPushedQuantities() failed (non-fatal):", error);
  }
}

/**
 * Single-owner counterpart to `pushStockToShopify`, for the automatic
 * push after a local stock change (see pushStockAfterLocalChange) — every
 * Shopify-linked (product|variation, location) row for one product or
 * variation, recomputed fresh from the database. Unlike WooCommerce,
 * Shopify has no single collapsed number to push, so this pushes each
 * linked location's own current sellable quantity, batched in one
 * mutation call. Returns whether anything was actually pushed —
 * best-effort, never throws.
 */
export async function pushStockForShopifyOwner(
  client: ShopifyClient,
  owner: { productId?: string; variationId?: string }
): Promise<boolean> {
  if (!owner.variationId && !owner.productId) return false;
  try {
    const items = await prisma.inventoryItem.findMany({
      where: {
        ...(owner.variationId ? { variationId: owner.variationId } : { productId: owner.productId! }),
        externalId: { not: null },
        warehouse: { source: "SHOPIFY", externalId: { not: null } },
      },
      include: { warehouse: { select: { externalId: true } } },
    });
    if (items.length === 0) return false;

    const entries = items.map((item) => ({
      inventoryItemId: item.externalId!,
      locationId: item.warehouse.externalId!,
      quantity: availableStock(item),
    }));

    await client.setInventoryQuantities(entries);
    await recordPushedQuantities(entries);
    return true;
  } catch (error) {
    console.error("pushStockForShopifyOwner() failed (non-fatal):", error);
    return false;
  }
}
