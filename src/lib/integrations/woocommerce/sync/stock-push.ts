import "server-only";

import { prisma } from "@/lib/prisma";
import { availableStockTotal } from "@/lib/inventory";
import type { WooCommerceClient } from "../client";
import { emptySyncSummary, recordNote, type SyncSummary } from "./types";

type ItemWithWarehouse = {
  id: string;
  quantityOnHand: number;
  quantityReserved: number;
  warehouse: { type: "ENTREPOT" | "MAGASIN"; isActive: boolean };
};

/**
 * Sellable stock to publish to the online storefront (Phase 32b business
 * rule — docs/adr/0020-stock-transfers.md §10): ONLY active-ENTREPOT
 * inventory feeds WooCommerce; MAGASIN stock never does. Also returns
 * which rows actually contributed, so a caller can stamp them with the
 * pushed quantity (the echo-loop guard — see reconcileStockFromProvider).
 *
 *  - no InventoryItem row at all → `sellable: null` → caller skips the
 *    push (preserve pre-32b behaviour for untracked products).
 *  - has inventory rows but zero active-ENTREPOT stock (everything is at a
 *    MAGASIN, or only at an inactive/retired ENTREPOT) → `0`, pushed so the
 *    storefront quantity goes to 0 instead of staying stale.
 *  - otherwise → sellable units summed across the active ENTREPOTs.
 */
function onlineSellableStock(items: ItemWithWarehouse[]): { sellable: number | null; contributingIds: string[] } {
  if (items.length === 0) return { sellable: null, contributingIds: [] };
  const entrepot = items.filter((i) => i.warehouse.type === "ENTREPOT" && i.warehouse.isActive);
  return { sellable: availableStockTotal(entrepot) ?? 0, contributingIds: entrepot.map((i) => i.id) };
}

/** Stamps the echo-loop guard (see reconcileStockFromProvider) on every
 * InventoryItem row that fed into a just-pushed number. Best-effort: a
 * failure here must not fail the push itself, which already happened. */
async function recordPushedQuantity(itemIds: string[], quantity: number): Promise<void> {
  if (itemIds.length === 0) return;
  try {
    await prisma.inventoryItem.updateMany({
      where: { id: { in: itemIds } },
      data: { lastPushedQuantity: quantity, lastPushedAt: new Date() },
    });
  } catch (error) {
    console.error("recordPushedQuantity() failed (non-fatal):", error);
  }
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
        const { sellable, contributingIds } = onlineSellableStock(variation.inventoryItems);
        if (sellable == null) {
          summary.skipped++;
          continue;
        }
        try {
          await client.updateStock(wcProductId, sellable, wcVariationId);
          summary.updated++;
          await recordPushedQuantity(contributingIds, sellable);
        } catch {
          recordNote(summary, `Variation ${variation.sku} : échec de l'envoi du stock à WooCommerce.`);
          summary.failed++;
        }
      }
      continue;
    }

    const { sellable, contributingIds } = onlineSellableStock(product.inventoryItems);
    if (sellable == null) {
      summary.skipped++;
      continue;
    }
    try {
      await client.updateStock(wcProductId, sellable);
      summary.updated++;
      await recordPushedQuantity(contributingIds, sellable);
    } catch {
      recordNote(summary, `Produit ${product.sku} : échec de l'envoi du stock à WooCommerce.`);
      summary.failed++;
    }
  }

  return summary;
}

/**
 * Single-item counterpart to `pushStockToWooCommerce`, for the automatic
 * push after a local stock change (see pushStockAfterLocalChange) — one
 * product or variation, recomputed fresh from the database rather than
 * trusting a caller-supplied number, so it can never push a stale value.
 * Same sellable-stock rule (active-ENTREPOT only) and the same echo-loop
 * guard stamp as the batch push. Returns whether the push actually
 * happened (false when there's nothing to push, e.g. not WooCommerce-
 * linked, or no inventory row at all) — best-effort, never throws.
 */
export async function pushStockForWooCommerceOwner(
  client: WooCommerceClient,
  owner: { productId?: string; variationId?: string }
): Promise<boolean> {
  const itemInclude = { include: { warehouse: { select: { type: true, isActive: true } } } } as const;

  try {
    if (owner.variationId) {
      const variation = await prisma.productVariation.findUnique({
        where: { id: owner.variationId },
        include: { inventoryItems: itemInclude, product: { select: { source: true, externalId: true } } },
      });
      if (!variation || variation.source !== "WOOCOMMERCE" || !variation.externalId) return false;
      if (!variation.product || variation.product.source !== "WOOCOMMERCE" || !variation.product.externalId) return false;
      const wcProductId = Number(variation.product.externalId);
      const wcVariationId = Number(variation.externalId);
      if (!Number.isFinite(wcProductId) || !Number.isFinite(wcVariationId)) return false;

      const { sellable, contributingIds } = onlineSellableStock(variation.inventoryItems);
      if (sellable == null) return false;
      await client.updateStock(wcProductId, sellable, wcVariationId);
      await recordPushedQuantity(contributingIds, sellable);
      return true;
    }

    if (!owner.productId) return false;
    const product = await prisma.product.findUnique({
      where: { id: owner.productId },
      include: { inventoryItems: itemInclude },
    });
    if (!product || product.source !== "WOOCOMMERCE" || !product.externalId) return false;
    const wcProductId = Number(product.externalId);
    if (!Number.isFinite(wcProductId)) return false;

    const { sellable, contributingIds } = onlineSellableStock(product.inventoryItems);
    if (sellable == null) return false;
    await client.updateStock(wcProductId, sellable);
    await recordPushedQuantity(contributingIds, sellable);
    return true;
  } catch (error) {
    console.error("pushStockForWooCommerceOwner() failed (non-fatal):", error);
    return false;
  }
}
