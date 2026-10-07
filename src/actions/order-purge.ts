"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { releaseStockForOrder } from "@/lib/inventory";
import { checkAndNotifyLowStock } from "@/lib/notifications";
import { pushStockAfterLocalChange } from "@/lib/integrations/shared/auto-push";
import { displayOrderNumber } from "@/lib/format";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import { evaluateOrderPurge, type PurgeEvaluation, type PurgeOrderSnapshot } from "@/lib/orders/purge";
import { actionError, actionOk, type ActionResult } from "@/actions/types";
import type { PrismaTransactionClient } from "@/lib/prisma";

/**
 * Controlled purge of a TEST order (rules: src/lib/orders/purge.ts).
 * `orders.purge` — OWNER / ADMIN only. One transaction, the order row locked
 * (`SELECT … FOR UPDATE`, the same guard as cancel / physical return) and
 * eligibility re-checked under the lock, then:
 *   1. a held reservation is released by releaseStockForOrder (LIBERATION
 *      movement) — stock quantities are never edited directly;
 *   2. failed shipment attempts (ECHEC, no carrier parcel) are deleted;
 *   3. notifications about this order are deleted;
 *   4. the order is deleted (its lines and confirmation attempts with it).
 * Inventory movements are KEPT (their order link is set to null by the
 * database) and so is every existing audit event; `order.purged` records
 * the order number, total, lines, reason and actor. Numbers are never
 * reused (orderNumber is a sequence, displayNumber a per-tenant counter).
 */

class PurgeRefusedError extends Error {
  constructor(public reasons: string[]) {
    super(reasons.join(" "));
  }
}

const snapshotInclude = {
  items: { select: { productId: true, variationId: true, nameSnapshot: true, skuSnapshot: true, quantity: true } },
  shipments: { select: { id: true, status: true, externalId: true, trackingNumber: true } },
  _count: { select: { refunds: true, returns: true, commissionEntries: true } },
} as const;

async function loadSnapshot(db: typeof prisma | PrismaTransactionClient, orderId: string) {
  const order = await db.order.findUnique({ where: { id: orderId }, include: snapshotInclude });
  if (!order) return null;
  const snapshot: PurgeOrderSnapshot = {
    status: order.status,
    source: order.source,
    shippedAt: order.shippedAt,
    items: order.items,
    shipments: order.shipments,
    refundCount: order._count.refunds,
    returnCount: order._count.returns,
    commissionEntryCount: order._count.commissionEntries,
  };
  return { order, snapshot };
}

/** Read-only: what a purge of this order would do, or why it is refused. */
export async function previewOrderPurgeAction(orderId: string): Promise<ActionResult<PurgeEvaluation>> {
  await requirePermissionForAction("orders.purge");
  const loaded = await loadSnapshot(prisma, String(orderId ?? ""));
  if (!loaded) return actionError("Commande introuvable.");
  return actionOk(evaluateOrderPurge(loaded.snapshot));
}

export async function purgeTestOrderAction(input: { orderId: string; reason: string }): Promise<ActionResult<{ id: string; label: string }>> {
  const user = await requirePermissionForAction("orders.purge");
  const orderId = String(input.orderId ?? "");
  const reason = String(input.reason ?? "").trim();
  if (!orderId) return actionError("Commande invalide.");
  if (reason.length < 3) return actionError("Indiquez le motif de la purge.");
  const { orderNumberPrefix } = await getReportBusinessInfo();

  let released: { productIds: (string | null)[]; variationIds: (string | null)[] } | null = null;
  let label: string;
  try {
    label = await prisma.$transaction(async (tx) => {
      // Row lock: a concurrent confirmation / shipment / cancel on this order
      // waits, then this transaction re-reads the committed state.
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "orders" WHERE id = ${orderId} FOR UPDATE`;
      if (locked.length === 0) throw new PurgeRefusedError(["Commande introuvable."]);

      const loaded = await loadSnapshot(tx, orderId);
      if (!loaded) throw new PurgeRefusedError(["Commande introuvable."]);
      const { order, snapshot } = loaded;
      const evaluation = evaluateOrderPurge(snapshot);
      if (!evaluation.eligible) throw new PurgeRefusedError(evaluation.reasons);
      const orderLabel = displayOrderNumber(order, orderNumberPrefix);

      // 1. Reservation → released through the domain function (LIBERATION movement).
      if (evaluation.preview.releaseReservation) {
        await releaseStockForOrder(tx, order.id, order.items, user.id);
        released = { productIds: order.items.map((i) => i.productId), variationIds: order.items.map((i) => i.variationId) };
      }
      // 2. Failed creation attempts only (re-checked by the where clause).
      if (evaluation.preview.failedShipmentIds.length > 0) {
        await tx.shipment.deleteMany({
          where: { id: { in: evaluation.preview.failedShipmentIds }, orderId: order.id, status: "ECHEC", externalId: null },
        });
      }
      // 3. Notifications pointing at this order.
      await tx.notification.deleteMany({ where: { entityType: "Order", entityId: order.id } });
      // 4. The order (lines + confirmation attempts cascade; movements keep their row, orderId → null).
      await tx.order.delete({ where: { id: order.id } });

      await recordAuditEvent(
        {
          actorType: "USER",
          actorUserId: user.id,
          action: "order.purged",
          entityType: "Order",
          entityId: order.id,
          previousValue: {
            orderNumber: order.orderNumber,
            displayNumber: order.displayNumber,
            label: orderLabel,
            status: order.status,
            total: order.total.toString(),
            currency: order.currency,
            lines: order.items.map((i) => ({ name: i.nameSnapshot, sku: i.skuSnapshot, quantity: i.quantity })),
          },
          metadata: {
            reason,
            reservationReleased: evaluation.preview.releaseReservation,
            failedShipmentsRemoved: evaluation.preview.failedShipmentIds.length,
          },
        },
        tx
      );
      return orderLabel;
    });
  } catch (error) {
    if (error instanceof PurgeRefusedError) return actionError(error.message);
    throw error;
  }

  // Best-effort, after commit — same as cancelling: the released units are
  // available again, so refresh low-stock alerts and the storefront stock.
  if (released) {
    await checkAndNotifyLowStock(released);
    await pushStockAfterLocalChange(released);
  }
  revalidatePath("/commandes");
  revalidatePath("/livraison");
  return actionOk({ id: orderId, label });
}
