import "server-only";

import { prisma } from "@/lib/prisma";
import type { WooCommerceClient } from "../client";
import { reconcileStockFromWooCommerce } from "./stock";
import type { SyncActor } from "./actor";

/**
 * Single-owner counterpart to `pushStockForWooCommerceOwner`, but for the
 * PULL direction — fetches ONLY this exact product or variation's current
 * `stock_quantity` from WooCommerce (never the whole catalog, never a
 * sibling variation) and reconciles it via the existing, safe
 * `reconcileStockFromWooCommerce` path. Used by
 * `pullStockBeforeReservationRelease` right before this app releases a
 * WooCommerce order's reservation at EXPEDIEE (docs/adr/0030's #15627
 * addendum) — never from the disabled broad product-webhook pull
 * (`516e393`'s `reconcileStock` gate is untouched by this function).
 *
 * Read-only against WooCommerce: this never calls `updateStock`, so it
 * cannot push anything back and cannot participate in a push/pull loop.
 * Best-effort — never throws; returns whether a reconciliation actually
 * ran.
 */
export async function pullStockForWooCommerceOwner(
  client: WooCommerceClient,
  owner: { productId?: string; variationId?: string },
  actor: SyncActor
): Promise<boolean> {
  try {
    const warehouse = await prisma.warehouse.findFirst({ where: { isDefault: true } });
    if (!warehouse) return false;

    if (owner.variationId) {
      const variation = await prisma.productVariation.findUnique({
        where: { id: owner.variationId },
        include: { product: { select: { source: true, externalId: true } } },
      });
      if (!variation || variation.source !== "WOOCOMMERCE" || !variation.externalId) return false;
      if (!variation.product || variation.product.source !== "WOOCOMMERCE" || !variation.product.externalId) return false;
      const wcProductId = Number(variation.product.externalId);
      const wcVariationId = Number(variation.externalId);
      if (!Number.isFinite(wcProductId) || !Number.isFinite(wcVariationId)) return false;

      const wcVariation = await client.getProductVariation(wcProductId, wcVariationId);
      if (!wcVariation.manage_stock || wcVariation.stock_quantity == null) return false;

      await reconcileStockFromWooCommerce({
        variationId: variation.id,
        warehouseId: warehouse.id,
        externalQuantity: wcVariation.stock_quantity,
        actor,
      });
      return true;
    }

    if (!owner.productId) return false;
    const product = await prisma.product.findUnique({
      where: { id: owner.productId },
      select: { source: true, externalId: true },
    });
    if (!product || product.source !== "WOOCOMMERCE" || !product.externalId) return false;
    const wcProductId = Number(product.externalId);
    if (!Number.isFinite(wcProductId)) return false;

    const wcProduct = await client.getProduct(wcProductId);
    if (!wcProduct.manage_stock || wcProduct.stock_quantity == null) return false;

    await reconcileStockFromWooCommerce({
      productId: owner.productId,
      warehouseId: warehouse.id,
      externalQuantity: wcProduct.stock_quantity,
      actor,
    });
    return true;
  } catch (error) {
    console.error("pullStockForWooCommerceOwner() failed (non-fatal):", error);
    return false;
  }
}
