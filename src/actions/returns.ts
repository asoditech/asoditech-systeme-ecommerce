"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { applyPhysicalReturnLine, resolveOrderStockWarehouseId, getDefaultWarehouseId } from "@/lib/inventory";
import { checkAndNotifyLowStock } from "@/lib/notifications";
import { pushStockAfterLocalChange } from "@/lib/integrations/shared/auto-push";
import { confirmPhysicalReturnSchema, type ConfirmPhysicalReturnInput } from "@/lib/validation/returns";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";

/** Thrown when a submitted line would exceed what EXPEDIEE actually
 * consumed minus what was already returned — the whole request is
 * rejected, never partially applied (the transaction rolls back). */
class ReturnCeilingExceededError extends Error {}

/** Thrown when no warehouse can be resolved for a line at all (a
 * deployment with no default warehouse) — a degenerate case, never a
 * normal business rejection. */
class NoWarehouseError extends Error {}

/**
 * Confirm a physical-return event on a shipped order — the ONLY mechanism
 * that credits physically-returned stock back to InventoryItem
 * (docs/adr/0036-inventory-single-source-of-truth.md). Fully decoupled
 * from `Order.status`: never changes it, and is never triggered by a
 * status change (RETOUR/ANNULEE are workflow labels only — see
 * src/actions/orders.ts).
 *
 * One order can have several return events over time (partial returns);
 * each line is split between sellable (restored to on-hand) and damaged
 * (recorded in quantityDamaged, never on-hand). The cumulative returned
 * quantity per order item is hard-capped, transactionally, by what
 * EXPEDIEE actually consumed for that item (its own `quantity` — no
 * split-shipment support in this version, so "consumed" is simply the
 * order item's full quantity once the order has shipped).
 *
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
export async function confirmPhysicalReturnAction(
  input: ConfirmPhysicalReturnInput
): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("orders.return");

  const parsed = confirmPhysicalReturnSchema.safeParse(input);
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const order = await prisma.order.findUnique({
    where: { id: parsed.data.orderId },
    include: { items: true },
  });
  if (!order) return actionError("Commande introuvable.");
  if (order.shippedAt === null) {
    return actionError("Cette commande n'a pas encore été expédiée — aucune unité physique à retourner.");
  }

  const itemsById = new Map(order.items.map((i) => [i.id, i]));
  for (const line of parsed.data.lines) {
    if (!itemsById.has(line.orderItemId)) {
      return actionError("Une ligne de retour référence un article qui n'appartient pas à cette commande.");
    }
  }

  // Merge duplicate lines for the same order item within one request — the
  // ceiling check below must see the true combined request, not let a
  // split submission of the same item across two lines bypass it.
  const mergedLines = new Map<string, { quantitySellable: number; quantityDamaged: number }>();
  for (const line of parsed.data.lines) {
    const prev = mergedLines.get(line.orderItemId) ?? { quantitySellable: 0, quantityDamaged: 0 };
    mergedLines.set(line.orderItemId, {
      quantitySellable: prev.quantitySellable + line.quantitySellable,
      quantityDamaged: prev.quantityDamaged + line.quantityDamaged,
    });
  }

  const touchedRefs = { productIds: [] as (string | null)[], variationIds: [] as (string | null)[] };

  let returnId: string;
  try {
    returnId = await prisma.$transaction(async (tx) => {
      // Row lock on the order — the actual concurrency guard (see this
      // function's own doc comment). Held until this transaction commits.
      await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${parsed.data.orderId} FOR UPDATE`;

      // Idempotency check AFTER acquiring the lock, so a genuine
      // concurrent retry of the identical request can't race past it.
      const existingReturn = await tx.orderReturn.findUnique({
        where: {
          orderId_idempotencyKey: { orderId: parsed.data.orderId, idempotencyKey: parsed.data.idempotencyKey },
        },
      });
      if (existingReturn) return existingReturn.id;

      // What every order item has already had returned across every prior
      // event, read fresh inside the lock.
      const previouslyReturned = await tx.orderReturnLine.groupBy({
        by: ["orderItemId"],
        where: { orderReturn: { orderId: parsed.data.orderId } },
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
          orderId: parsed.data.orderId,
          idempotencyKey: parsed.data.idempotencyKey,
          receivedById: user.id,
          note: parsed.data.note && parsed.data.note.trim().length > 0 ? parsed.data.note.trim() : null,
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
            performedById: user.id,
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
          actorUserId: user.id,
          action: "order.return_confirmed",
          entityType: "Order",
          entityId: order.id,
          newValue: { orderReturnId: orderReturn.id, lines: appliedLines },
          metadata: { note: parsed.data.note ?? undefined },
        },
        tx
      );

      return orderReturn.id;
    });
  } catch (error) {
    if (error instanceof ReturnCeilingExceededError || error instanceof NoWarehouseError) {
      return actionError(error.message);
    }
    throw error;
  }

  // Best-effort, after commit — same convention as every other stock
  // mutation (checkAndNotifyLowStock resolves a stale low-stock alert now
  // that units are back; pushStockAfterLocalChange pushes the new
  // sellable number outward for every order source, docs/adr/0036).
  if (touchedRefs.productIds.length > 0 || touchedRefs.variationIds.length > 0) {
    await checkAndNotifyLowStock(touchedRefs);
    await pushStockAfterLocalChange(touchedRefs);
  }

  revalidatePath("/commandes");
  revalidatePath(`/commandes/${parsed.data.orderId}`);
  return actionOk({ id: returnId });
}
