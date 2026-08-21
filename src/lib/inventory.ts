import "server-only";

import type { Prisma, InventoryMovementType } from "@prisma/client";

type Tx = Prisma.TransactionClient;

interface StockLineRef {
  productId?: string | null;
  variationId?: string | null;
  quantity: number;
}

/** Thrown when a movement would drive on-hand or reserved stock negative. */
export class InsufficientStockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientStockError";
  }
}

/**
 * Applies one inventory movement against the item's current-state cache and
 * records the movement row in the same transaction. Silently no-ops if no
 * InventoryItem exists for the line (product/variation not stock-tracked,
 * or created before a default warehouse existed) — orders must never fail
 * to save because of a missing inventory row.
 *
 * The increment + post-update check (rather than a pre-check on a value
 * read before the transaction started) is deliberate: Postgres takes a row
 * lock on the `UPDATE`, so under concurrent calls the second transaction's
 * `increment` is applied against the first transaction's already-committed
 * result, not a stale snapshot — closing the race where two concurrent
 * fulfillments could each independently pass a "would this go negative?"
 * check computed from the same pre-transaction read and both apply,
 * driving stock negative. Throwing here rolls back the whole transaction
 * (including the InventoryMovement insert and the Order/Shipment update
 * that triggered it), so the caller must catch `InsufficientStockError`
 * and turn it into a friendly French `actionError` rather than let it
 * surface as an unhandled 500 — see src/actions/orders.ts.
 *
 * NOTE: `findFirst` here is not scoped to a specific warehouse — correct
 * only under the current single-default-warehouse assumption (see
 * docs/adr/0005-inventory-and-sync.md). Once multi-warehouse fulfillment
 * routing exists, this must take an explicit warehouseId.
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

  const updated = await tx.inventoryItem.update({
    where: { id: item.id },
    data: {
      quantityOnHand: { increment: onHandDelta * line.quantity },
      quantityReserved: { increment: reservedDelta * line.quantity },
    },
  });

  if (updated.quantityOnHand < 0) {
    throw new InsufficientStockError(
      `Stock insuffisant : ${-updated.quantityOnHand} unité(s) manquante(s) pour cet article.`
    );
  }
  if (updated.quantityReserved < 0) {
    // Reserved can only go negative from a prior data-consistency drift
    // (e.g. a manual adjustment made between reservation and release) —
    // clamp rather than block an otherwise-legitimate cancellation/return,
    // but this is never expected in the normal reserve->fulfill/release
    // lifecycle and is worth surfacing if it ever happens.
    await tx.inventoryItem.update({ where: { id: item.id }, data: { quantityReserved: 0 } });
  }

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
