"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { requireLocationAccessForAction } from "@/lib/auth/location-access";
import { recordAuditEvent } from "@/lib/audit";
import { checkAndNotifyLowStock } from "@/lib/notifications";
import { pushStockAfterLocalChange } from "@/lib/integrations/shared/auto-push";
import { applyStockMovement, InsufficientStockError } from "@/lib/inventory";
import { inventoryAdjustmentSchema, locationCostSchema, type LocationCostInput } from "@/lib/validation/inventory";
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
  // Location Access Management v1 (docs/adr/0037): OWNER/ADMIN bypass;
  // everyone else must be explicitly assigned to this warehouse.
  await requireLocationAccessForAction(user, warehouse.id);

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

  // Runs on any change, up or down: a decrease may cross below the
  // threshold (new alert), an increase may cross back above it (clears the
  // standing alert — see checkAndNotifyLowStock).
  await checkAndNotifyLowStock({ productIds: [item.productId], variationIds: [item.variationId] });

  // Real-time half of the automatic sync (see docs/adr/0010 and 0011): a
  // manual adjustment on a WooCommerce/Shopify-linked product pushes its
  // new sellable stock back to the store immediately, instead of only
  // once someone next clicks "Pousser le stock". Silently no-ops for an
  // INTERNE item or an unconnected integration.
  await pushStockAfterLocalChange({ productIds: [item.productId], variationIds: [item.variationId] });

  revalidatePath("/stock");
  revalidatePath("/produits");
  return actionOk(updated);
}

/**
 * Sets or clears the CURRENT purchase cost of one stock location for one
 * product/variation (InventoryItem.currentUnitCost — never a selling price).
 * `cost: null` = « Utiliser le coût global »: the effective cost falls back to
 * the variation, then product, cost. Touches ONLY that row's currentUnitCost —
 * never Product.cost / ProductVariation.cost, a cost snapshot, a movement's
 * unitCost or a transfer line. Independent of the transfer-cost setting (which
 * governs only the automatic writes).
 *
 * Purchase cost is `finance.view` data (docs/adr/0043); the row's location
 * must also be one the user may operate on (docs/adr/0037). The tenant scope
 * of `findUnique` makes another tenant's row « introuvable ».
 */
export async function updateLocationCostAction(
  input: LocationCostInput
): Promise<ActionResult<{ id: string; cost: string | null }>> {
  const user = await requirePermissionForAction("finance.view");

  const parsed = locationCostSchema.safeParse(input);
  if (!parsed.success) return actionError("Coût invalide.", parsed.error.flatten().fieldErrors);

  const existing = await prisma.inventoryItem.findUnique({
    where: { id: parsed.data.inventoryItemId },
    select: {
      id: true,
      warehouseId: true,
      productId: true,
      variationId: true,
      currentUnitCost: true,
      variation: { select: { productId: true } },
    },
  });
  if (!existing) return actionError("Stock introuvable.");
  await requireLocationAccessForAction(user, existing.warehouseId);

  const next = parsed.data.cost;
  // One row, one column, in a transaction — the location's quantities and
  // every other cost field are left exactly as they are.
  const updated = await prisma.$transaction((tx) =>
    tx.inventoryItem.update({
      where: { id: existing.id },
      data: { currentUnitCost: next },
      select: { id: true, currentUnitCost: true },
    })
  );

  const before = existing.currentUnitCost?.toString() ?? null;
  const after = updated.currentUnitCost?.toString() ?? null;
  if (before !== after) {
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "inventory.location_cost_updated",
      entityType: "InventoryItem",
      entityId: existing.id,
      previousValue: { currentUnitCost: before },
      newValue: { currentUnitCost: after },
      metadata: { warehouseId: existing.warehouseId, productId: existing.productId, variationId: existing.variationId },
    });
  }

  const productId = existing.productId ?? existing.variation?.productId;
  if (productId) revalidatePath(`/produits/${productId}`);
  revalidatePath("/stock");
  revalidatePath("/rapports/stock");
  return actionOk({ id: updated.id, cost: after });
}

