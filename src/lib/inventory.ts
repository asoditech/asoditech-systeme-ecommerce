import "server-only";

import type { Prisma, InventoryMovementType } from "@prisma/client";

type Tx = Prisma.TransactionClient;

interface StockLineRef {
  productId?: string | null;
  variationId?: string | null;
  quantity: number;
}

/**
 * Applies one inventory movement against the item's current-state cache and
 * records the movement row in the same transaction. Silently no-ops if no
 * InventoryItem exists for the line (product/variation not stock-tracked,
 * or created before a default warehouse existed) — orders must never fail
 * to save because of a missing inventory row.
 */
async function applyMovement(
  tx: Tx,
  line: StockLineRef,
  type: InventoryMovementType,
  onHandDelta: number,
  reservedDelta: number,
  orderId: string | null,
  performedById: string | null,
  reason?: string
) {
  if (line.quantity <= 0) return;

  const item = line.variationId
    ? await tx.inventoryItem.findFirst({ where: { variationId: line.variationId } })
    : line.productId
      ? await tx.inventoryItem.findFirst({ where: { productId: line.productId } })
      : null;
  if (!item) return;

  await tx.inventoryItem.update({
    where: { id: item.id },
    data: {
      quantityOnHand: { increment: onHandDelta * line.quantity },
      quantityReserved: { increment: reservedDelta * line.quantity },
    },
  });

  await tx.inventoryMovement.create({
    data: {
      inventoryItemId: item.id,
      type,
      quantity: line.quantity,
      orderId,
      performedById,
      reason: reason ?? null,
    },
  });
}

/** Order created — reserve stock without touching on-hand quantity. */
export async function reserveStockForOrder(
  tx: Tx,
  orderId: string,
  lines: StockLineRef[],
  performedById: string | null
) {
  for (const line of lines) {
    await applyMovement(tx, line, "RESERVATION", 0, 1, orderId, performedById);
  }
}

/** Order shipped — convert the reservation into an actual stock deduction. */
export async function fulfillStockForOrder(
  tx: Tx,
  orderId: string,
  lines: StockLineRef[],
  performedById: string | null
) {
  for (const line of lines) {
    await applyMovement(tx, line, "VENTE", -1, -1, orderId, performedById);
  }
}

/** Order cancelled before shipment — release the reservation. */
export async function releaseStockForOrder(
  tx: Tx,
  orderId: string,
  lines: StockLineRef[],
  performedById: string | null
) {
  for (const line of lines) {
    await applyMovement(tx, line, "LIBERATION", 0, -1, orderId, performedById);
  }
}

/** Order returned/cancelled after shipment — goods physically come back. */
export async function returnStockForOrder(
  tx: Tx,
  orderId: string,
  lines: StockLineRef[],
  performedById: string | null,
  reason?: string
) {
  for (const line of lines) {
    await applyMovement(tx, line, "RETOUR", 1, 0, orderId, performedById, reason);
  }
}
