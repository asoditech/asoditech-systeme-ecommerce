"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { checkAndNotifyLowStock } from "@/lib/notifications";
import { applyStockMovement, InsufficientStockError } from "@/lib/inventory";
import { inventoryAdjustmentSchema } from "@/lib/validation/inventory";
import { actionError, actionOk, type ActionResult } from "@/actions/types";
import type { InventoryItem } from "@prisma/client";

/**
 * Positive movement types add to on-hand stock; negative ones subtract.
 * AJUSTEMENT_NEGATIF and ENDOMMAGE both remove stock but are recorded with
 * distinct movement types so history reads correctly.
 */
const POSITIVE_TYPES = new Set(["AJUSTEMENT_POSITIF", "RETOUR", "RECEPTION"]);

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

  // Never trust the client's warehouseId — resolve and validate it here.
  const warehouse = await prisma.warehouse.findUnique({ where: { id: parsed.data.warehouseId } });
  if (!warehouse) return actionError("Entrepôt introuvable.");
  if (!warehouse.isActive) {
    return actionError("Cet entrepôt est désactivé. Réactivez-le pour ajuster son stock.");
  }

  const item = parsed.data.variationId
    ? await prisma.inventoryItem.findUnique({
        where: { warehouseId_variationId: { warehouseId: warehouse.id, variationId: parsed.data.variationId } },
      })
    : await prisma.inventoryItem.findUnique({
        where: { warehouseId_productId: { warehouseId: warehouse.id, productId: parsed.data.productId! } },
      });

  if (!item) {
    return actionError("Aucun enregistrement de stock trouvé pour ce produit dans cet entrepôt.");
  }

  const isPositive = POSITIVE_TYPES.has(parsed.data.type);
  const previousQuantityOnHand = item.quantityOnHand;

  let updated: InventoryItem;
  try {
    updated = await prisma.$transaction(async (tx) => {
      const result = await applyStockMovement(tx, {
        warehouseId: warehouse.id,
        productId: item.productId,
        variationId: item.variationId,
        type: parsed.data.type,
        quantity: parsed.data.quantity,
        onHandDelta: isPositive ? parsed.data.quantity : -parsed.data.quantity,
        damagedDelta: parsed.data.type === "ENDOMMAGE" ? parsed.data.quantity : 0,
        performedById: user.id,
        reason: parsed.data.reason,
      });
      // The item is guaranteed to exist (checked above, same transaction
      // scope for the mutation), so `applied` is always true here.
      if (!result.applied) {
        throw new Error("inventory item disappeared mid-adjustment");
      }
      return result.item;
    });
  } catch (error) {
    if (error instanceof InsufficientStockError) {
      return actionError("Cet ajustement rendrait le stock négatif.");
    }
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
    metadata: { type: parsed.data.type, reason: parsed.data.reason, warehouseId: warehouse.id },
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
