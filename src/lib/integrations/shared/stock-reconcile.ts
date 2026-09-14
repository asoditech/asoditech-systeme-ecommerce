import "server-only";

import { prisma } from "@/lib/prisma";
import type { SyncActor } from "./actor";
import type { RecordSource } from "@prisma/client";

/**
 * Provider → System stock ONBOARDING (docs/adr/0036-inventory-single-source
 * -of-truth.md). `InventoryItem` is ASODITECH's SOLE source of truth for
 * local physical stock once a row exists for a (warehouse, product|
 * variation) pair — a connected store's own reported quantity is only ever
 * used to INITIALIZE a row this app doesn't know about yet (a product/
 * variation/location it has never seen locally). Once that row exists,
 * this function never overwrites `quantityOnHand` again, no matter how far
 * the provider's own number drifts from it — WooCommerce/Shopify stock is
 * one-way downstream only (ASODITECH → store) after onboarding.
 *
 * This used to also reconcile an EXISTING row toward the provider's number
 * (AJUSTEMENT_POSITIF/AJUSTEMENT_NEGATIF) — that "keep drifting toward the
 * provider" behavior is exactly what let a routine "Synchroniser les
 * produits" run, or an inbound `inventory_levels/update` webhook, silently
 * overwrite stock ASODITECH's own order lifecycle (reservations,
 * fulfillment, physical returns) had already correctly moved. Removed by
 * design, not simplified away — see the ADR's "previous behavior" section.
 *
 * Safe to call repeatedly and indefinitely: a second, third, hundredth
 * onboarding sync of an already-known row is always a no-op.
 */
export async function reconcileStockFromProvider(params: {
  productId?: string;
  variationId?: string;
  warehouseId: string;
  externalQuantity: number;
  actor: SyncActor;
  source: RecordSource;
  /** The provider's own InventoryItem-shaped resource id, if it has a distinct one (e.g. Shopify's InventoryItem gid) — not every provider needs this (WooCommerce has no separate concept). */
  externalItemId?: string;
}): Promise<"created" | "unchanged"> {
  const { productId, variationId, warehouseId, externalQuantity, externalItemId } = params;
  const where = variationId ? { warehouseId, variationId } : { warehouseId, productId };

  const existing = await prisma.inventoryItem.findFirst({ where });

  if (!existing) {
    await prisma.inventoryItem.create({
      data: {
        warehouseId,
        productId: productId ?? null,
        variationId: variationId ?? null,
        quantityOnHand: Math.max(0, externalQuantity),
        externalId: externalItemId ?? null,
      },
    });
    return "created";
  }

  // A pure identity/mapping field, not a stock quantity — safe (and
  // useful, so future pushes target the right provider resource) to keep
  // in sync even though `quantityOnHand` itself is never touched below.
  if (externalItemId && existing.externalId !== externalItemId) {
    await prisma.inventoryItem.update({ where: { id: existing.id }, data: { externalId: externalItemId } });
  }

  return "unchanged";
}
