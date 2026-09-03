import "server-only";

import type { InventoryItem, InventoryMovementType, Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/** Thrown when a movement would drive on-hand stock negative. Rolls back
 * the whole transaction (movement row + the Order/Shipment update that
 * triggered it), so every caller must catch it and turn it into a
 * friendly `actionError` — see src/actions/orders.ts / src/actions/inventory.ts. */
export class InsufficientStockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientStockError";
  }
}

// ---------------------------------------------------------------------------
// Derived available stock — THE single definition (Phase 32a).
// Never stored in the database; always `max(0, onHand - reserved)`.
// See docs/adr/0019-inventory-foundation.md.
// ---------------------------------------------------------------------------

/** Sellable/available units for ONE (warehouse, product|variation) row. */
export function availableStock(item: { quantityOnHand: number; quantityReserved: number }): number {
  return Math.max(0, item.quantityOnHand - item.quantityReserved);
}

/**
 * Sellable/available units across a set of inventory rows (e.g. every
 * warehouse a product sits in). Returns `null` for an empty set — the
 * WooCommerce/Shopify stock-push callers rely on `null` meaning "no
 * inventory row, don't push a number". Behaviourally identical to the
 * former `sellableQuantity()` helpers those files each carried.
 */
export function availableStockTotal(
  items: { quantityOnHand: number; quantityReserved: number }[]
): number | null {
  if (items.length === 0) return null;
  const onHand = items.reduce((sum, i) => sum + i.quantityOnHand, 0);
  const reserved = items.reduce((sum, i) => sum + i.quantityReserved, 0);
  return Math.max(0, onHand - reserved);
}

// ---------------------------------------------------------------------------
// Canonical stock-mutation primitive (Phase 32a).
// ---------------------------------------------------------------------------

export interface ApplyStockMovementInput {
  /** REQUIRED. The exact location whose InventoryItem row is mutated —
   * resolved and validated by the caller, never guessed here. */
  warehouseId: string;
  /** Exactly one of productId / variationId (mirrors the InventoryItem
   * `exactly_one_ref` DB CHECK). */
  productId?: string | null;
  variationId?: string | null;
  type: InventoryMovementType;
  /** Magnitude recorded verbatim on the InventoryMovement row (> 0). */
  quantity: number;
  // NOTE on productId + variationId: `variationId` takes precedence. An
  // order line for a variation legitimately carries BOTH (parent product +
  // the variation) — createOrderAction snapshots them together — so this
  // must not reject "both set". Only "neither set" is an error.
  /** Signed amounts applied to the cache columns. `onHandDelta: -q` for a
   * sale, `+q` for a return, `0` for a pure reservation, etc. */
  onHandDelta: number;
  reservedDelta?: number;
  damagedDelta?: number;
  orderId?: string | null;
  performedById?: string | null;
  reason?: string | null;
}

export type ApplyStockMovementResult =
  | { applied: true; item: InventoryItem; movementId: string }
  | { applied: false; reason: "no_inventory_item" | "noop" };

/**
 * The ONE way application code changes stock. Every existing flow — order
 * reservation / release / fulfillment / return, manual adjustment, and
 * provider reconciliation — routes through here (Phase 32a). It:
 *
 *  1. resolves the InventoryItem by `(warehouseId, variation)` — or
 *     `(warehouseId, product)` when no variationId is given — via the
 *     compound unique index; never `findFirst({ productId })`, which could
 *     pick the wrong warehouse. `variationId` wins when both are supplied
 *     (an order line for a variation carries both), matching the former
 *     `applyMovement` and `reconcileStockFromProvider`;
 *  2. applies the deltas with `increment` and re-reads the POST-update row
 *     inside the caller's transaction — Postgres's row lock on the `UPDATE`
 *     is what closes the concurrent-mutation race, not any pre-check;
 *  3. throws `InsufficientStockError` (rolling the transaction back) if
 *     on-hand went negative — the existing project policy, unchanged;
 *  4. clamps a negative `quantityReserved` to 0 (only reachable from prior
 *     data drift, never the normal reserve→fulfill/release path);
 *  5. writes the immutable `InventoryMovement` row in the same transaction.
 *
 * Silent no-op (`applied: false`) when no InventoryItem row exists for the
 * pair — an order must never fail to save because a product isn't
 * stock-tracked, exactly as before. The caller owns the `$transaction`.
 */
export async function applyStockMovement(
  tx: Tx,
  input: ApplyStockMovementInput
): Promise<ApplyStockMovementResult> {
  if (input.quantity <= 0) return { applied: false, reason: "noop" };

  if (!input.variationId && !input.productId) {
    throw new Error("applyStockMovement: a productId or a variationId is required.");
  }

  const item = input.variationId
    ? await tx.inventoryItem.findUnique({
        where: { warehouseId_variationId: { warehouseId: input.warehouseId, variationId: input.variationId } },
      })
    : await tx.inventoryItem.findUnique({
        where: { warehouseId_productId: { warehouseId: input.warehouseId, productId: input.productId! } },
      });
  if (!item) return { applied: false, reason: "no_inventory_item" };

  let updated = await tx.inventoryItem.update({
    where: { id: item.id },
    data: {
      quantityOnHand: { increment: input.onHandDelta },
      quantityReserved: { increment: input.reservedDelta ?? 0 },
      quantityDamaged: { increment: input.damagedDelta ?? 0 },
    },
  });

  if (updated.quantityOnHand < 0) {
    throw new InsufficientStockError(
      `Stock insuffisant : ${-updated.quantityOnHand} unité(s) manquante(s) pour cet article.`
    );
  }
  if (updated.quantityReserved < 0) {
    updated = await tx.inventoryItem.update({ where: { id: item.id }, data: { quantityReserved: 0 } });
  }

  const movement = await tx.inventoryMovement.create({
    data: {
      inventoryItemId: item.id,
      type: input.type,
      quantity: input.quantity,
      orderId: input.orderId ?? null,
      performedById: input.performedById ?? null,
      reason: input.reason ?? null,
    },
  });

  return { applied: true, item: updated, movementId: movement.id };
}

// ---------------------------------------------------------------------------
// Order → stock. Warehouse is now explicit (Phase 32a).
// ---------------------------------------------------------------------------

interface StockLineRef {
  productId?: string | null;
  variationId?: string | null;
  quantity: number;
}

/**
 * The warehouse an INTERNE order's stock movements target. Compatibility
 * rule for the pre-32a single-warehouse world (docs/adr/0019-inventory-foundation.md):
 *   1. the default warehouse, when the product/variation has an
 *      InventoryItem there — the overwhelmingly common case
 *      (`createProductAction` / `createProductVariationAction` seed exactly
 *      that row);
 *   2. else its single InventoryItem row, if it has exactly one (e.g. a
 *      product whose only stock lives at a Shopify Location) — preserves
 *      the old `findFirst` behaviour for the one-row case;
 *   3. else the default warehouse id (so `applyStockMovement` no-ops rather
 *      than mutating an arbitrary one of several rows — never guesses).
 * Returns `null` only when there is no default warehouse AND no row at all.
 */
async function resolveOrderStockWarehouseId(tx: Tx, ref: StockLineRef): Promise<string | null> {
  // An order line whose product/variation was deleted (OrderItem FK is
  // onDelete: SetNull) has neither id — nothing to resolve, and a
  // `{ productId: undefined }` filter would scan the whole table.
  if (!ref.variationId && !ref.productId) return null;

  const rows = await tx.inventoryItem.findMany({
    where: ref.variationId ? { variationId: ref.variationId } : { productId: ref.productId! },
    select: { warehouseId: true, warehouse: { select: { isDefault: true, createdAt: true } } },
    orderBy: { warehouse: { createdAt: "asc" } },
  });

  const atDefault = rows.find((r) => r.warehouse.isDefault);
  if (atDefault) return atDefault.warehouseId;
  if (rows.length === 1) return rows[0].warehouseId;

  const def = await tx.warehouse.findFirst({ where: { isDefault: true }, select: { id: true } });
  if (def) return def.id;
  return rows[0]?.warehouseId ?? null;
}

async function applyOrderLines(
  tx: Tx,
  orderId: string,
  lines: StockLineRef[],
  performedById: string | null,
  type: InventoryMovementType,
  onHandPerUnit: number,
  reservedPerUnit: number,
  reason?: string
) {
  for (const line of lines) {
    if (line.quantity <= 0) continue;
    // Orphaned line (product/variation deleted → OrderItem FK SetNull) —
    // silent no-op, exactly as the former applyMovement did.
    if (!line.productId && !line.variationId) continue;
    const warehouseId = await resolveOrderStockWarehouseId(tx, line);
    if (!warehouseId) continue;
    await applyStockMovement(tx, {
      warehouseId,
      productId: line.productId ?? null,
      variationId: line.variationId ?? null,
      type,
      quantity: line.quantity,
      onHandDelta: onHandPerUnit * line.quantity,
      reservedDelta: reservedPerUnit * line.quantity,
      orderId,
      performedById,
      reason,
    });
  }
}

/** Order created — reserve stock without touching on-hand quantity. */
export async function reserveStockForOrder(tx: Tx, orderId: string, lines: StockLineRef[], performedById: string | null) {
  await applyOrderLines(tx, orderId, lines, performedById, "RESERVATION", 0, 1);
}

/** Order shipped — convert the reservation into an actual stock deduction. */
export async function fulfillStockForOrder(tx: Tx, orderId: string, lines: StockLineRef[], performedById: string | null) {
  await applyOrderLines(tx, orderId, lines, performedById, "VENTE", -1, -1);
}

/** Order cancelled before shipment — release the reservation. */
export async function releaseStockForOrder(tx: Tx, orderId: string, lines: StockLineRef[], performedById: string | null) {
  await applyOrderLines(tx, orderId, lines, performedById, "LIBERATION", 0, -1);
}

/** Order returned/cancelled after shipment — goods physically come back. */
export async function returnStockForOrder(
  tx: Tx,
  orderId: string,
  lines: StockLineRef[],
  performedById: string | null,
  reason?: string
) {
  await applyOrderLines(tx, orderId, lines, performedById, "RETOUR", 1, 0, reason);
}
