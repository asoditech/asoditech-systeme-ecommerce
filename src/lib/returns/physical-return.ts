import "server-only";

import type { Order, OrderItem } from "@prisma/client";
import type { PrismaTransactionClient } from "@/lib/prisma";
import { recordAuditEvent } from "@/lib/audit";
import { applyPhysicalReturnLine, resolveOrderStockWarehouseId, getDefaultWarehouseId } from "@/lib/inventory";

/**
 * The physical-return transaction body (docs/adr/0036), shared by the order
 * page's « Retour physique » (confirmPhysicalReturnAction) and the P3 returns
 * workspace inspection (src/lib/returns/reception.ts). Moved here verbatim
 * from src/actions/returns.ts — same lock, idempotency, ceilings, stock
 * movements and audit; the caller owns the `$transaction` and everything that
 * runs after commit.
 */

/** Thrown when a submitted line would exceed what EXPEDIEE actually
 * consumed minus what was already returned — the whole request is
 * rejected, never partially applied (the transaction rolls back). */
export class ReturnCeilingExceededError extends Error {}

/** Thrown when no warehouse can be resolved for a line at all (a
 * deployment with no default warehouse) — a degenerate case, never a
 * normal business rejection. */
export class NoWarehouseError extends Error {}

export interface MergedReturnQuantities {
  quantitySellable: number;
  quantityDamaged: number;
}

/** Merge duplicate lines for the same order item within one request — the
 * ceiling check must see the true combined request, not let a split
 * submission of the same item across two lines bypass it. */
export function mergeReturnLines(
  lines: readonly { orderItemId: string; quantitySellable: number; quantityDamaged: number }[]
): Map<string, MergedReturnQuantities> {
  const mergedLines = new Map<string, MergedReturnQuantities>();
  for (const line of lines) {
    const prev = mergedLines.get(line.orderItemId) ?? { quantitySellable: 0, quantityDamaged: 0 };
    mergedLines.set(line.orderItemId, {
      quantitySellable: prev.quantitySellable + line.quantitySellable,
      quantityDamaged: prev.quantityDamaged + line.quantityDamaged,
    });
  }
  return mergedLines;
}

export interface TouchedStockRefs {
  productIds: (string | null)[];
  variationIds: (string | null)[];
}

export interface RecordPhysicalReturnInput {
  order: Order & { items: OrderItem[] };
  userId: string;
  idempotencyKey: string;
  /** As submitted — stored trimmed on the event, echoed raw in the audit. */
  note?: string | null;
  mergedLines: Map<string, MergedReturnQuantities>;
  /** Extra audit metadata (the workspace adds its reception / shipment). */
  auditMetadata?: Record<string, string | null>;
  /** Called with each line's resolved warehouse before anything is written
   * for it; throwing rolls the whole transaction back. */
  authorizeLineWarehouse?: (warehouseId: string) => Promise<void>;
}

export interface RecordPhysicalReturnResult {
  returnId: string;
  /** false = an exact (orderId, idempotencyKey) retry — nothing was written. */
  created: boolean;
  touchedRefs: TouchedStockRefs;
}

/**
 * Concurrency: a `SELECT ... FOR UPDATE` on the order row (same technique
 * as `createRefundAction`'s identical race) serializes every physical
 * -return submission for this order — two concurrent requests can never
 * both read the same "remaining" quantity and both apply, because the
 * second is blocked until the first's transaction (and its newly
 * inserted `OrderReturnLine` rows) has committed.
 *
 * Idempotency: `@@unique([orderId, idempotencyKey])` on `OrderReturn` — a
 * retry of the exact same (orderId, idempotencyKey) is a silent no-op
 * (returns the existing event's id), never a second event or a second set
 * of inventory movements.
 */
export async function recordPhysicalReturn(
  tx: PrismaTransactionClient,
  input: RecordPhysicalReturnInput
): Promise<RecordPhysicalReturnResult> {
  const { order, mergedLines } = input;
  const itemsById = new Map(order.items.map((i) => [i.id, i]));
  const touchedRefs: TouchedStockRefs = { productIds: [], variationIds: [] };

  // Row lock on the order — the actual concurrency guard (see this
  // function's own doc comment). Held until this transaction commits.
  await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${order.id} FOR UPDATE`;

  // Idempotency check AFTER acquiring the lock, so a genuine
  // concurrent retry of the identical request can't race past it.
  const existingReturn = await tx.orderReturn.findUnique({
    where: {
      orderId_idempotencyKey: { orderId: order.id, idempotencyKey: input.idempotencyKey },
    },
  });
  if (existingReturn) return { returnId: existingReturn.id, created: false, touchedRefs };

  // What every order item has already had returned across every prior
  // event, read fresh inside the lock.
  const previouslyReturned = await tx.orderReturnLine.groupBy({
    by: ["orderItemId"],
    where: { orderReturn: { orderId: order.id } },
    _sum: { quantitySellable: true, quantityDamaged: true },
  });
  const alreadyReturnedByItem = new Map(
    previouslyReturned
      .filter((r): r is typeof r & { orderItemId: string } => r.orderItemId !== null)
      .map((r) => [r.orderItemId, (r._sum.quantitySellable ?? 0) + (r._sum.quantityDamaged ?? 0)])
  );

  // Validate every line's ceiling BEFORE writing anything — reject the
  // entire request rather than partially apply it (the transaction
  // rollback on throw already guarantees this; validating up front
  // keeps the failure reason about the actual violating line, not an
  // arbitrary later one).
  for (const [orderItemId, requested] of mergedLines) {
    const item = itemsById.get(orderItemId)!;
    // No split-shipment support in this version (docs/adr/0036) — the
    // physically-consumed quantity at EXPEDIEE is simply the order
    // item's own full quantity once the order has shipped.
    const consumed = item.quantity;
    const already = alreadyReturnedByItem.get(orderItemId) ?? 0;
    const remaining = consumed - already;
    const requestedTotal = requested.quantitySellable + requested.quantityDamaged;
    if (requestedTotal > remaining) {
      throw new ReturnCeilingExceededError(
        `« ${item.nameSnapshot} » : ${requestedTotal} unité(s) demandée(s), ${remaining} restante(s) à retourner.`
      );
    }
  }

  const orderReturn = await tx.orderReturn.create({
    data: {
      orderId: order.id,
      idempotencyKey: input.idempotencyKey,
      receivedById: input.userId,
      note: input.note && input.note.trim().length > 0 ? input.note.trim() : null,
    },
  });

  const appliedLines: {
    orderItemId: string;
    nameSnapshot: string;
    quantitySellable: number;
    quantityDamaged: number;
    warehouseId: string;
  }[] = [];

  for (const [orderItemId, requested] of mergedLines) {
    const item = itemsById.get(orderItemId)!;

    // The same warehouse EXPEDIEE fulfilled this line from, when the
    // product/variation still exists; otherwise fall back to the
    // order's own fulfilment warehouse so the line still records a
    // real location even though no stock movement can be applied for
    // a deleted product — see resolveOrderStockWarehouseId's own doc
    // comment and applyPhysicalReturnLine's no-op-on-missing-item
    // behavior.
    const resolvedWarehouseId = await resolveOrderStockWarehouseId(
      tx,
      { productId: item.productId, variationId: item.variationId, quantity: item.quantity },
      order.fulfillmentWarehouseId
    );
    const warehouseId = resolvedWarehouseId ?? order.fulfillmentWarehouseId ?? (await getDefaultWarehouseId(tx));
    if (!warehouseId) {
      throw new NoWarehouseError("Aucun entrepôt disponible pour enregistrer ce retour.");
    }
    if (input.authorizeLineWarehouse) await input.authorizeLineWarehouse(warehouseId);

    await tx.orderReturnLine.create({
      data: {
        orderReturnId: orderReturn.id,
        orderItemId: item.id,
        nameSnapshot: item.nameSnapshot,
        skuSnapshot: item.skuSnapshot,
        quantitySellable: requested.quantitySellable,
        quantityDamaged: requested.quantityDamaged,
        warehouseId,
      },
    });

    if (item.productId || item.variationId) {
      await applyPhysicalReturnLine(tx, {
        warehouseId,
        productId: item.productId,
        variationId: item.variationId,
        quantitySellable: requested.quantitySellable,
        quantityDamaged: requested.quantityDamaged,
        orderId: order.id,
        orderReturnId: orderReturn.id,
        performedById: input.userId,
      });
      touchedRefs.productIds.push(item.productId);
      touchedRefs.variationIds.push(item.variationId);
    }

    appliedLines.push({
      orderItemId: item.id,
      nameSnapshot: item.nameSnapshot,
      quantitySellable: requested.quantitySellable,
      quantityDamaged: requested.quantityDamaged,
      warehouseId,
    });
  }

  await recordAuditEvent(
    {
      actorType: "USER",
      actorUserId: input.userId,
      action: "order.return_confirmed",
      entityType: "Order",
      entityId: order.id,
      newValue: { orderReturnId: orderReturn.id, lines: appliedLines },
      metadata: { note: input.note ?? undefined, ...input.auditMetadata },
    },
    tx
  );

  return { returnId: orderReturn.id, created: true, touchedRefs };
}
