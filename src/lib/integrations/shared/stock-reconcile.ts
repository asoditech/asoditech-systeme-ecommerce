import "server-only";

import { prisma } from "@/lib/prisma";
import { recordAuditEvent } from "@/lib/audit";
import { actorAuditFields, actorPerformedById, type SyncActor } from "./actor";
import { checkAndNotifyLowStock } from "@/lib/notifications";
import type { RecordSource } from "@prisma/client";

/**
 * Provider → System stock reconciliation (the "pull" half of any
 * bidirectional inventory sync). Extracted during Phase 21 from the
 * WooCommerce integration (Phase 20) — the logic itself has no
 * WooCommerce-specific data, only the audit metadata's `source` tag
 * varies per caller. See docs/adr/0010-woocommerce-integration.md and
 * docs/adr/0011-shopify-integration.md.
 *
 * On first sight of a product/variation at a given warehouse (no
 * InventoryItem row yet), the external quantity *initializes* the row
 * directly — not a business event, exactly like createProductAction
 * seeding `quantityOnHand: 0` with no movement. On every subsequent sync,
 * if the external snapshot disagrees with the current internal quantity,
 * this applies an explicit AJUSTEMENT_POSITIF/AJUSTEMENT_NEGATIF movement
 * (the same movement types manual stock corrections use) plus an
 * `inventory.reconciled` audit event — the difference is always recorded,
 * never silently overwritten. If the two already agree, nothing is
 * written at all (no phantom movement merely because a read happened).
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
}): Promise<"created" | "reconciled" | "unchanged"> {
  const { productId, variationId, warehouseId, externalQuantity, actor, source, externalItemId } = params;
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

  if (externalItemId && existing.externalId !== externalItemId) {
    await prisma.inventoryItem.update({ where: { id: existing.id }, data: { externalId: externalItemId } });
  }

  const delta = externalQuantity - existing.quantityOnHand;
  if (delta === 0) return "unchanged";

  await prisma.$transaction(async (tx) => {
    const updated = await tx.inventoryItem.update({
      where: { id: existing.id },
      data: { quantityOnHand: { increment: delta } },
    });

    await tx.inventoryMovement.create({
      data: {
        inventoryItemId: existing.id,
        type: delta > 0 ? "AJUSTEMENT_POSITIF" : "AJUSTEMENT_NEGATIF",
        quantity: Math.abs(delta),
        reason: `Synchronisation ${source} (import du stock)`,
        performedById: actorPerformedById(actor),
      },
    });

    await recordAuditEvent({
      ...actorAuditFields(actor),
      action: "inventory.reconciled",
      entityType: "InventoryItem",
      entityId: existing.id,
      previousValue: { quantityOnHand: existing.quantityOnHand },
      newValue: { quantityOnHand: updated.quantityOnHand },
      metadata: { source },
    });
  });

  // The provider's own count just moved us down — surface anything now low,
  // exactly as a manual downward adjustment does (src/actions/inventory.ts).
  if (delta < 0) {
    await checkAndNotifyLowStock({ productIds: [productId], variationIds: [variationId] }, actorPerformedById(actor));
  }

  return "reconciled";
}
