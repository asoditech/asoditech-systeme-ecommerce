import "server-only";

import { prisma } from "@/lib/prisma";
import type { ShopifyClient } from "../client";
import { availableFrom, type ShopifyVariant } from "../types";
import { reconcileStockFromProvider, type SyncActor } from "@/lib/integrations/shared";

/**
 * Single-owner counterpart to `pushStockForShopifyOwner`, but for the
 * PULL direction — fetches ONLY this exact product's current data
 * (`getProduct`, already a single-product call, never a catalog sync) and
 * reconciles ONLY the affected variant's inventory levels via the
 * existing, safe `reconcileStockFromProvider` path. Used by
 * `pullStockBeforeReservationRelease` right before this app releases a
 * Shopify order's reservation at EXPEDIEE (docs/adr/0030's #15627
 * addendum).
 *
 * Read-only against Shopify: this never calls `setInventoryQuantities`,
 * so it cannot push anything back and cannot participate in a push/pull
 * loop. Best-effort — never throws; returns whether a reconciliation
 * actually ran.
 */
export async function pullStockForShopifyOwner(
  client: ShopifyClient,
  owner: { productId?: string; variationId?: string },
  actor: SyncActor
): Promise<boolean> {
  try {
    if (owner.variationId) {
      const variation = await prisma.productVariation.findUnique({
        where: { id: owner.variationId },
        include: { product: { select: { source: true, externalId: true } } },
      });
      if (!variation || variation.source !== "SHOPIFY" || !variation.externalId) return false;
      if (!variation.product || variation.product.source !== "SHOPIFY" || !variation.product.externalId) return false;

      const product = await client.getProduct(variation.product.externalId);
      const variant = product?.variants.nodes.find((v) => v.id === variation.externalId);
      if (!variant) return false;

      return await reconcileVariant(variant, { variationId: variation.id }, actor);
    }

    if (!owner.productId) return false;
    const product = await prisma.product.findUnique({
      where: { id: owner.productId },
      select: { source: true, externalId: true },
    });
    if (!product || product.source !== "SHOPIFY" || !product.externalId) return false;

    const wcProduct = await client.getProduct(product.externalId);
    const variant = wcProduct?.variants.nodes[0];
    if (!variant) return false;

    return await reconcileVariant(variant, { productId: owner.productId }, actor);
  } catch (error) {
    console.error("pullStockForShopifyOwner() failed (non-fatal):", error);
    return false;
  }
}

async function reconcileVariant(
  variant: ShopifyVariant,
  target: { productId?: string; variationId?: string },
  actor: SyncActor
): Promise<boolean> {
  const warehouses = await prisma.warehouse.findMany({
    where: { source: "SHOPIFY", externalId: { not: null } },
    select: { id: true, externalId: true },
  });

  let reconciled = false;
  for (const warehouse of warehouses) {
    const available = availableFrom(variant.inventoryItem.inventoryLevels.nodes, warehouse.externalId!);
    if (available == null) continue;
    await reconcileStockFromProvider({
      ...target,
      warehouseId: warehouse.id,
      externalQuantity: available,
      actor,
      source: "SHOPIFY",
      externalItemId: variant.inventoryItem.id,
    });
    reconciled = true;
  }
  return reconciled;
}
