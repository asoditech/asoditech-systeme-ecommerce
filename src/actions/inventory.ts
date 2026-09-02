"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { checkAndNotifyLowStock } from "@/lib/notifications";
import { inventoryAdjustmentSchema } from "@/lib/validation/inventory";
import { actionError, actionOk, type ActionResult } from "@/actions/types";
import type { InventoryItem } from "@prisma/client";

/**
 * Positive movement types add to on-hand stock; negative ones subtract.
 * AJUSTEMENT_NEGATIF and ENDOMMAGE both remove stock but are recorded with
 * distinct movement types so history reads correctly.
 */
const POSITIVE_TYPES = new Set(["AJUSTEMENT_POSITIF", "RETOUR", "RECEPTION"]);

class NegativeStockError extends Error {}

export async function adjustInventoryAction(formData: FormData): Promise<ActionResult<InventoryItem>> {
  const user = await requirePermissionForAction("inventory.adjust");

  const parsed = inventoryAdjustmentSchema.safeParse({
    productId: formData.get("productId"),
    variationId: formData.get("variationId"),
    warehouseId: formData.get("warehouseId"),
    type: formData.get("type"),
    quantity: formData.get("quantity"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const item = parsed.data.variationId
    ? await prisma.inventoryItem.findFirst({ where: { variationId: parsed.data.variationId, warehouseId: parsed.data.warehouseId } })
    : await prisma.inventoryItem.findFirst({ where: { productId: parsed.data.productId, warehouseId: parsed.data.warehouseId } });

  if (!item) {
    return actionError("Aucun enregistrement de stock trouvé pour ce produit dans cet entrepôt.");
  }

  const delta = POSITIVE_TYPES.has(parsed.data.type) ? parsed.data.quantity : -parsed.data.quantity;
  const previousQuantityOnHand = item.quantityOnHand;

  // The negative-stock check is done AFTER applying the increment inside
  // the transaction, not against `item.quantityOnHand` read above — that
  // read can be stale under concurrent adjustments (two requests both
  // reading 3 in stock, both requesting -3, both passing a pre-check, both
  // applying, landing on -3). Postgres locks the row for the `UPDATE`, so
  // the second transaction's increment is applied against the first
  // transaction's already-committed result; checking the post-update value
  // here is what actually prevents negative stock under concurrency, not
  // just a nicety. Found during the A–G audit; see
  // docs/adr/0005-inventory-and-sync.md.
  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      const result = await tx.inventoryItem.update({
        where: { id: item.id },
        data: {
          quantityOnHand: { increment: delta },
          ...(parsed.data.type === "ENDOMMAGE" ? { quantityDamaged: { increment: parsed.data.quantity } } : {}),
        },
      });
      if (result.quantityOnHand < 0) {
        throw new NegativeStockError("Cet ajustement rendrait le stock négatif.");
      }
      await tx.inventoryMovement.create({
        data: {
          inventoryItemId: item.id,
          type: parsed.data.type,
          quantity: parsed.data.quantity,
          reason: parsed.data.reason,
          performedById: user.id,
        },
      });
      return result;
    });
  } catch (error) {
    if (error instanceof NegativeStockError) return actionError(error.message);
    throw error;
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "inventory.adjusted",
    entityType: "InventoryItem",
    entityId: item.id,
    previousValue: { quantityOnHand: previousQuantityOnHand },
    newValue: { quantityOnHand: updated.quantityOnHand },
    metadata: { type: parsed.data.type, reason: parsed.data.reason },
  });

  if (updated.quantityOnHand < previousQuantityOnHand) {
    await checkAndNotifyLowStock(
      { productIds: [item.productId], variationIds: [item.variationId] },
      user.id
    );
  }

  revalidatePath("/stock");
  revalidatePath("/produits");
  return actionOk(updated);
}
