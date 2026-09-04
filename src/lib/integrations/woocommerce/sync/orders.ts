import "server-only";

import { prisma } from "@/lib/prisma";
import { recordAuditEvent } from "@/lib/audit";
import { canTransitionOrderStatus } from "@/lib/validation/order";
import { mapCustomerFieldsFromOrder, mapOrderFields, mapOrderStatus, mapPaymentMethod, totalRefundedAmount } from "../mapper";
import type { WcOrder } from "../types";
import { actorAuditFields, actorPerformedById, type SyncActor } from "./actor";
import { isRecentlyPlaced, parseOrderPlacedAt } from "../../shared/order-recency";
import { notifyNewOrder } from "@/lib/notifications";
import { emptySyncSummary, recordNote, type SyncSummary } from "./types";
import type { Prisma, OrderStatus } from "@prisma/client";
import { isUniqueConstraintError } from "@/lib/prisma-errors";

/**
 * WooCommerce → System, one direction, always (see docs/adr/0010-woocommerce-integration.md
 * — the internal order state machine remains authoritative for what
 * happens to an order *after* import; this never writes back to
 * WooCommerce). Shared by the bulk "Synchroniser les commandes" action and
 * the order.created/order.updated webhook handler, so both paths behave
 * identically.
 *
 * Deliberately NOT done here: reserving/fulfilling internal stock via
 * reserveStockForOrder/fulfillStockForOrder. A WooCommerce order's stock
 * impact already happened on the WooCommerce side — it is reflected into
 * this system via the separate stock-pull reconciliation
 * (sync/stock.ts), not by re-running the internal reservation ledger a
 * second time against the same units. Running both would double-count.
 *
 * Deliberately NOT done here: reconciling OrderItems on a re-import. A WC
 * order's line items are fixed at placement; a re-import (webhook
 * order.updated, or a later manual sync) only refreshes order-level fields
 * (status where the transition is valid, totals, customer snapshot,
 * refund state) — never rewrites line items already recorded.
 */
export async function importOrder(
  wc: WcOrder,
  actor: SyncActor
): Promise<{ outcome: "imported" | "updated" | "unchanged" | "skipped"; reason?: string }> {
  const statusMapping = mapOrderStatus(wc.status);
  if (!statusMapping.ok) {
    return { outcome: "skipped", reason: statusMapping.reason };
  }

  const customerId = await resolveCustomerForOrder(wc, actor);
  const externalId = String(wc.id);
  const existing = await prisma.order.findFirst({ where: { source: "WOOCOMMERCE", externalId } });

  if (existing) {
    return updateExistingOrder(existing.id, wc, statusMapping.status, actor);
  }

  try {
    return await createImportedOrder(wc, statusMapping.status, customerId, actor);
  } catch (error) {
    // Backstop for a genuine race (the order.created webhook and a
    // concurrent manual "Synchroniser les commandes" both importing the
    // same new WooCommerce order for the first time) — the unique
    // (source, externalId) index rejects the loser's insert with P2002;
    // treat that as "someone else just created it" and fall through to the
    // normal update path instead of surfacing a failure. See
    // docs/adr/0010-woocommerce-integration.md.
    if (isUniqueConstraintError(error)) {
      const winner = await prisma.order.findFirst({ where: { source: "WOOCOMMERCE", externalId } });
      if (winner) return updateExistingOrder(winner.id, wc, statusMapping.status, actor);
    }
    throw error;
  }
}

async function resolveCustomerForOrder(wc: WcOrder, actor: SyncActor): Promise<string> {
  const fields = mapCustomerFieldsFromOrder(wc);

  const existing =
    wc.customer_id > 0
      ? await prisma.customer.findFirst({ where: { source: "WOOCOMMERCE", externalId: String(wc.customer_id) } })
      : fields.email
        ? await prisma.customer.findFirst({ where: { source: "WOOCOMMERCE", email: fields.email } })
        : null;

  if (existing) {
    await prisma.customer.update({
      where: { id: existing.id },
      data: {
        fullName: fields.fullName,
        email: fields.email,
        phone: fields.phone,
        city: fields.city,
        region: fields.region,
        country: fields.country,
      },
    });
    return existing.id;
  }

  const created = await prisma.customer.create({
    data: {
      ...fields,
      source: "WOOCOMMERCE",
      externalId: wc.customer_id > 0 ? String(wc.customer_id) : null,
    },
  });

  await recordAuditEvent({
    ...actorAuditFields(actor),
    action: "customer.created",
    entityType: "Customer",
    entityId: created.id,
    newValue: { fullName: created.fullName },
    metadata: { source: "WOOCOMMERCE" },
  });

  return created.id;
}

async function createImportedOrder(
  wc: WcOrder,
  status: OrderStatus,
  customerId: string,
  actor: SyncActor
): Promise<{ outcome: "imported" }> {
  const fields = mapOrderFields(wc, status);

  const items: Prisma.OrderItemCreateManyOrderInput[] = [];
  for (const li of wc.line_items) {
    const product = li.product_id
      ? await prisma.product.findFirst({ where: { source: "WOOCOMMERCE", externalId: String(li.product_id) } })
      : null;
    const variation = li.variation_id
      ? await prisma.productVariation.findFirst({ where: { source: "WOOCOMMERCE", externalId: String(li.variation_id) } })
      : null;

    items.push({
      productId: product?.id ?? null,
      variationId: variation?.id ?? null,
      nameSnapshot: li.name,
      skuSnapshot: li.sku?.trim() || `WC-LINE-${li.id}`,
      unitPrice: li.price,
      quantity: li.quantity,
      discount: Math.max(0, li.subtotal - li.total),
      total: li.total,
      costSnapshot: variation?.cost ?? product?.cost ?? null,
    });
  }

  const order = await prisma.order.create({
    data: {
      customerId,
      status: fields.status,
      paymentStatus: wc.status === "refunded" ? "REMBOURSE" : wc.date_paid ? "PAYE" : "EN_ATTENTE",
      paymentMethod: mapPaymentMethod(wc.payment_method),
      source: "WOOCOMMERCE",
      externalId: String(wc.id),
      externalNumber: wc.number,
      placedAt: parseOrderPlacedAt(wc.date_created),
      subtotal: fields.subtotal,
      discountTotal: fields.discountTotal,
      shippingCost: fields.shippingCost,
      total: fields.total,
      currency: fields.currency,
      shippingAddressLine1: fields.shippingAddressLine1,
      shippingAddressLine2: fields.shippingAddressLine2,
      shippingCity: fields.shippingCity,
      shippingRegion: fields.shippingRegion,
      shippingCountry: fields.shippingCountry,
      shippingPhone: fields.shippingPhone,
      notes: fields.notes,
      items: { create: items },
    },
  });

  const refunded = totalRefundedAmount(wc);
  if (refunded > 0) {
    await prisma.refund.create({
      data: {
        orderId: order.id,
        amount: refunded,
        reason: "Importé depuis WooCommerce",
        status: "COMPLETE",
        source: "WOOCOMMERCE",
      },
    });
  }

  await recordAuditEvent({
    ...actorAuditFields(actor),
    action: "order.created",
    entityType: "Order",
    entityId: order.id,
    newValue: { total: fields.total.toString(), customerId },
    metadata: { source: "WOOCOMMERCE", externalId: order.externalId },
  });

  // A webhook order.created is a real-time event — always alert. A manual
  // "Synchroniser les commandes" only alerts for an order actually placed
  // in the last couple of days, so a first-time history import doesn't
  // fan out hundreds of "nouvelle commande" notifications at once.
  if (actor.type === "INTEGRATION" || isRecentlyPlaced(wc.date_created)) {
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId }, select: { fullName: true } });
    await notifyNewOrder(
      { id: order.id, orderNumber: order.orderNumber, total: fields.total, currency: fields.currency, customerName: customer.fullName, source: "WOOCOMMERCE" },
      actorPerformedById(actor)
    );
  }

  return { outcome: "imported" };
}

async function updateExistingOrder(
  orderId: string,
  wc: WcOrder,
  status: OrderStatus,
  actor: SyncActor
): Promise<{ outcome: "updated" | "unchanged"; reason?: string }> {
  const existing = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const fields = mapOrderFields(wc, status);
  let changedFields = false;
  let statusSkippedReason: string | undefined;

  await prisma.$transaction(async (tx) => {
    if (existing.status !== status) {
      if (canTransitionOrderStatus(existing.status, status)) {
        const result = await tx.order.updateMany({
          where: { id: orderId, status: existing.status },
          data: { status },
        });
        if (result.count > 0) changedFields = true;
      } else {
        statusSkippedReason = `Commande WooCommerce #${wc.id} : transition ${existing.status} → ${status} ignorée (déjà en cours de traitement localement).`;
      }
    }

    const wantedPlacedAt = parseOrderPlacedAt(wc.date_created);
    const placedAtChanged = existing.placedAt.getTime() !== wantedPlacedAt.getTime();
    const totalsChanged =
      Number(existing.total) !== fields.total ||
      Number(existing.subtotal) !== fields.subtotal ||
      Number(existing.shippingCost) !== fields.shippingCost;
    if (totalsChanged || existing.notes !== fields.notes || placedAtChanged) {
      await tx.order.update({
        where: { id: orderId },
        data: {
          placedAt: wantedPlacedAt,
          subtotal: fields.subtotal,
          discountTotal: fields.discountTotal,
          shippingCost: fields.shippingCost,
          total: fields.total,
          shippingAddressLine1: fields.shippingAddressLine1,
          shippingAddressLine2: fields.shippingAddressLine2,
          shippingCity: fields.shippingCity,
          shippingRegion: fields.shippingRegion,
          shippingCountry: fields.shippingCountry,
          notes: fields.notes,
        },
      });
      changedFields = true;
    }

    const refunded = totalRefundedAmount(wc);
    if (refunded > 0) {
      const existingRefund = await tx.refund.findFirst({ where: { orderId, source: "WOOCOMMERCE" } });
      if (!existingRefund) {
        await tx.refund.create({
          data: { orderId, amount: refunded, reason: "Importé depuis WooCommerce", status: "COMPLETE", source: "WOOCOMMERCE" },
        });
        changedFields = true;
      } else if (Number(existingRefund.amount) !== refunded) {
        await tx.refund.update({ where: { id: existingRefund.id }, data: { amount: refunded } });
        changedFields = true;
      }
      if (wc.status === "refunded" && existing.paymentStatus !== "REMBOURSE") {
        await tx.order.update({ where: { id: orderId }, data: { paymentStatus: "REMBOURSE" } });
        changedFields = true;
      }
    }
  });

  if (changedFields) {
    await recordAuditEvent({
      ...actorAuditFields(actor),
      action: "order.updated",
      entityType: "Order",
      entityId: orderId,
      metadata: { source: "WOOCOMMERCE", via: actor.type === "INTEGRATION" ? "webhook_or_sync" : "sync" },
    });
  }

  return changedFields ? { outcome: "updated", reason: statusSkippedReason } : { outcome: "unchanged", reason: statusSkippedReason };
}

/**
 * Bulk order import — the manual "Synchroniser les commandes" action.
 * Scans the store's whole order history every run, skips orders already
 * held (their live edits arrive via the order.updated webhook, not here),
 * and does at most a bounded amount of real work — new imports (the
 * expensive path: several queries each) and placedAt corrections on
 * already-held orders (cheap: one field) each have their own, much
 * smaller cap — before asking to be re-run. Keeping both caps low is
 * deliberate: a serverless function has a hard wall-clock limit, and it
 * is far better for every click to finish and show real progress than
 * for a larger batch to occasionally run out of time and show nothing.
 */
const MAX_IMPORTS_PER_RUN = 40;
const MAX_PLACED_AT_FIXES_PER_RUN = 80;

export async function syncOrders(
  client: import("../client").WooCommerceClient,
  actor: SyncActor
): Promise<SyncSummary> {
  const summary = emptySyncSummary();

  let unreadable = 0;
  let importedThisRun = 0;
  let fixedThisRun = 0;
  let capped = false;

  for await (const { orders, unparsable } of client.listAllOrders()) {
    unreadable += unparsable;
    if (capped) break;

    // One query per page instead of one per order — which of these do we
    // already hold, and does the held row still have a placeholder
    // placedAt (== createdAt, from the migration backfill) that a re-sync
    // should correct to the real WooCommerce order date?
    const held = new Map(
      (
        await prisma.order.findMany({
          where: { source: "WOOCOMMERCE", externalId: { in: orders.map((o) => String(o.id)) } },
          select: { id: true, externalId: true, placedAt: true, createdAt: true },
        })
      ).map((r) => [r.externalId, r])
    );

    for (const wc of orders) {
      const existing = held.get(String(wc.id));
      if (existing) {
        if (existing.placedAt.getTime() !== existing.createdAt.getTime()) {
          summary.unchanged++;
          continue;
        }
        if (fixedThisRun >= MAX_PLACED_AT_FIXES_PER_RUN) {
          capped = true;
          break;
        }
        await prisma.order.update({
          where: { id: existing.id },
          data: { placedAt: parseOrderPlacedAt(wc.date_created) },
        });
        fixedThisRun++;
        summary.updated++;
        continue;
      }
      if (importedThisRun >= MAX_IMPORTS_PER_RUN) {
        capped = true;
        break;
      }
      try {
        const { outcome, reason } = await importOrder(wc, actor);
        summary[outcome]++;
        if (outcome === "imported") importedThisRun++;
        if (reason) recordNote(summary, reason);
      } catch {
        recordNote(summary, `Commande WooCommerce #${wc.id} : échec d'importation.`);
        summary.failed++;
      }
    }
  }

  if (capped) {
    recordNote(
      summary,
      `Lot traité (max ${MAX_IMPORTS_PER_RUN} nouvelles, ${MAX_PLACED_AT_FIXES_PER_RUN} dates corrigées) — relancez « Synchroniser les commandes » pour continuer.`
    );
  }
  if (unreadable > 0) {
    summary.failed += unreadable;
    recordNote(
      summary,
      `${unreadable} commande(s) ignorée(s) : format WooCommerce non reconnu.`
    );
  }

  return summary;
}
