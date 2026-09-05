import "server-only";

import { prisma } from "@/lib/prisma";
import { recordAuditEvent } from "@/lib/audit";
import { canTransitionOrderStatus } from "@/lib/validation/order";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { mapOrderStatus, mapPaymentMethod, totalRefundedAmount } from "../mapper";
import type { ShopifyOrder } from "../types";
import { actorAuditFields, actorPerformedById, emptySyncSummary, isRecentlyPlaced, parseOrderPlacedAt, recordNote, upsertCustomerAddressFromOrder, type SyncActor, type SyncSummary } from "@/lib/integrations/shared";
import { notifyNewOrder } from "@/lib/notifications";
import type { Prisma, OrderStatus } from "@prisma/client";

/**
 * Shopify → System, one direction, always (see docs/adr/0011-shopify-integration.md
 * — mirrors the WooCommerce integration's own reasoning). Shared by the
 * manual "Synchroniser les commandes" action and the orders/create and
 * orders/updated webhook handlers.
 *
 * Deliberately NOT done here: reserving/fulfilling internal stock — a
 * Shopify order's stock impact already happened on Shopify's side and is
 * reflected via the separate stock-pull reconciliation (sync/products.ts),
 * not by re-running the internal ledger a second time.
 *
 * Deliberately NOT done here: reconciling line items on a re-import — a
 * Shopify order's line items are fixed at placement; a re-import only
 * refreshes order-level fields (status where the transition is valid,
 * totals, customer snapshot, refund state).
 */
export async function importOrder(
  order: ShopifyOrder,
  actor: SyncActor
): Promise<{ outcome: "imported" | "updated" | "unchanged" | "skipped"; reason?: string }> {
  const statusMapping = mapOrderStatus(order.displayFinancialStatus, order.displayFulfillmentStatus, order.cancelledAt);
  if (!statusMapping.ok) {
    return { outcome: "skipped", reason: statusMapping.reason };
  }

  const customerId = await resolveCustomerForOrder(order, actor);

  // Copied into the customer's own address book (see
  // upsertCustomerAddressFromOrder's doc comment) so their Clients page
  // shows a real address instead of "Aucune adresse enregistrée".
  const shippingSource = order.shippingAddress ?? order.billingAddress;
  await upsertCustomerAddressFromOrder(customerId, {
    addressLine1: shippingSource?.address1 ?? null,
    addressLine2: shippingSource?.address2 ?? null,
    city: shippingSource?.city ?? null,
    region: shippingSource?.province ?? null,
    country: shippingSource?.country ?? null,
    phone: shippingSource?.phone ?? order.phone ?? null,
  });

  const existing = await prisma.order.findFirst({ where: { source: "SHOPIFY", externalId: order.id } });

  if (existing) {
    return updateExistingOrder(existing.id, order, statusMapping.status, actor);
  }

  try {
    return await createImportedOrder(order, statusMapping.status, customerId, actor);
  } catch (error) {
    // Backstop for a genuine race (a webhook delivery and a concurrent
    // manual sync both importing the same new Shopify order for the first
    // time) — the unique (source, externalId) index on Order (added
    // during Phase 20 for WooCommerce, provider-agnostic) rejects the
    // loser's insert with P2002; treat that as "someone else just created
    // it" and fall through to the update path. See
    // docs/adr/0010-woocommerce-integration.md's audit addendum.
    if (isUniqueConstraintError(error)) {
      const winner = await prisma.order.findFirst({ where: { source: "SHOPIFY", externalId: order.id } });
      if (winner) return updateExistingOrder(winner.id, order, statusMapping.status, actor);
    }
    throw error;
  }
}

function fullName(first?: string | null, last?: string | null): string {
  return [first, last].filter(Boolean).join(" ").trim();
}

/**
 * Match priority: Shopify customer id (a real account) → email → phone.
 * Most orders on this store are guest checkouts (no linked Shopify
 * customer), and a guest doesn't always fill in the same email twice —
 * but the phone number is what's actually reliable across their orders.
 * Without a phone fallback here, the same guest ordering twice created two
 * separate Customer rows every time, which is what showed up as the same
 * name/phone listed repeatedly on the Clients page with the order count
 * split across the duplicates instead of totalled on one row.
 */
async function findExistingShopifyCustomer(
  order: ShopifyOrder,
  email: string | null,
  phone: string | null
): Promise<{ id: string; externalId: string | null } | null> {
  if (order.customer) {
    const byExternalId = await prisma.customer.findFirst({
      where: { source: "SHOPIFY", externalId: order.customer.id },
      select: { id: true, externalId: true },
    });
    if (byExternalId) return byExternalId;
  }
  if (email) {
    const byEmail = await prisma.customer.findFirst({
      where: { source: "SHOPIFY", email },
      select: { id: true, externalId: true },
    });
    if (byEmail) return byEmail;
  }
  if (phone) {
    const byPhone = await prisma.customer.findFirst({
      where: { source: "SHOPIFY", phone },
      select: { id: true, externalId: true },
    });
    if (byPhone) return byPhone;
  }
  return null;
}

async function resolveCustomerForOrder(order: ShopifyOrder, actor: SyncActor): Promise<string> {
  const email = order.customer?.email ?? order.email ?? null;
  const address = order.shippingAddress ?? order.billingAddress;
  const name =
    fullName(order.customer?.firstName, order.customer?.lastName) ||
    fullName(address?.firstName, address?.lastName) ||
    email ||
    `Client Shopify ${order.name}`;
  const phone = order.customer?.phone ?? order.phone ?? address?.phone ?? null;

  const existing = await findExistingShopifyCustomer(order, email, phone);

  const fields = {
    fullName: name,
    email,
    phone,
    city: address?.city ?? null,
    region: address?.province ?? null,
    country: address?.country ?? "Maroc",
  };

  if (existing) {
    await prisma.customer.update({
      where: { id: existing.id },
      data: {
        ...fields,
        // Backfill the Shopify customer id once it's known (a guest's
        // first orders matched by email/phone, then they register) —
        // never overwrite one already recorded.
        externalId: existing.externalId ?? order.customer?.id ?? existing.externalId,
      },
    });
    return existing.id;
  }

  const created = await prisma.customer.create({
    data: { ...fields, source: "SHOPIFY", externalId: order.customer?.id ?? null },
  });

  await recordAuditEvent({
    ...actorAuditFields(actor),
    action: "customer.created",
    entityType: "Customer",
    entityId: created.id,
    newValue: { fullName: created.fullName },
    metadata: { source: "SHOPIFY" },
  });

  return created.id;
}

function mappedOrderFields(order: ShopifyOrder) {
  const address = order.shippingAddress ?? order.billingAddress;
  return {
    subtotal: order.subtotalPriceSet.amount,
    discountTotal: order.totalDiscountsSet?.amount ?? 0,
    shippingCost: order.totalShippingPriceSet.amount,
    total: order.currentTotalPriceSet.amount,
    currency: order.currentTotalPriceSet.currency,
    shippingAddressLine1: address?.address1 ?? null,
    shippingAddressLine2: address?.address2 ?? null,
    shippingCity: address?.city ?? null,
    shippingRegion: address?.province ?? null,
    shippingCountry: address?.country ?? null,
    shippingPhone: address?.phone ?? null,
    notes: order.note?.trim() || null,
  };
}

async function createImportedOrder(
  order: ShopifyOrder,
  status: OrderStatus,
  customerId: string,
  actor: SyncActor
): Promise<{ outcome: "imported" }> {
  const fields = mappedOrderFields(order);

  const items: Prisma.OrderItemCreateManyOrderInput[] = [];
  for (const li of order.lineItems.nodes) {
    const product = li.product ? await prisma.product.findFirst({ where: { source: "SHOPIFY", externalId: li.product.id } }) : null;
    const variation = li.variant ? await prisma.productVariation.findFirst({ where: { source: "SHOPIFY", externalId: li.variant.id } }) : null;

    items.push({
      productId: product?.id ?? null,
      variationId: variation?.id ?? null,
      nameSnapshot: li.title,
      skuSnapshot: li.sku?.trim() || `SHOPIFY-LINE-${li.id.split("/").pop()}`,
      unitPrice: li.originalUnitPriceSet.amount,
      quantity: li.quantity,
      discount: Math.max(0, li.originalTotalSet.amount - li.discountedTotalSet.amount),
      total: li.discountedTotalSet.amount,
      costSnapshot: variation?.cost ?? product?.cost ?? null,
    });
  }

  const createdOrder = await prisma.order.create({
    data: {
      customerId,
      status,
      paymentStatus: status === "REMBOURSEE" ? "REMBOURSE" : order.displayFinancialStatus === "PAID" ? "PAYE" : "EN_ATTENTE",
      paymentMethod: mapPaymentMethod(order.paymentGatewayNames),
      source: "SHOPIFY",
      externalId: order.id,
      externalNumber: order.name,
      placedAt: parseOrderPlacedAt(order.createdAt),
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

  const refunded = totalRefundedAmount(order);
  if (refunded > 0) {
    await prisma.refund.create({
      data: { orderId: createdOrder.id, amount: refunded, reason: "Importé depuis Shopify", status: "COMPLETE", source: "SHOPIFY" },
    });
  }

  await recordAuditEvent({
    ...actorAuditFields(actor),
    action: "order.created",
    entityType: "Order",
    entityId: createdOrder.id,
    newValue: { total: fields.total.toString(), customerId },
    metadata: { source: "SHOPIFY", externalId: createdOrder.externalId },
  });

  // A webhook order.created is a real-time event — always alert. A manual
  // "Synchroniser les commandes" only alerts for an order actually placed
  // in the last couple of days, so a first-time history import doesn't
  // fan out hundreds of "nouvelle commande" notifications at once.
  if (actor.type === "INTEGRATION" || isRecentlyPlaced(order.createdAt)) {
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId }, select: { fullName: true } });
    await notifyNewOrder(
      {
        id: createdOrder.id,
        orderNumber: createdOrder.orderNumber,
        total: fields.total,
        currency: fields.currency,
        customerName: customer.fullName,
        source: "SHOPIFY",
      },
      actorPerformedById(actor)
    );
  }

  return { outcome: "imported" };
}

async function updateExistingOrder(
  orderId: string,
  order: ShopifyOrder,
  status: OrderStatus,
  actor: SyncActor
): Promise<{ outcome: "updated" | "unchanged"; reason?: string }> {
  const existing = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const fields = mappedOrderFields(order);
  let changedFields = false;
  let statusSkippedReason: string | undefined;

  await prisma.$transaction(async (tx) => {
    if (existing.status !== status) {
      if (canTransitionOrderStatus(existing.status, status)) {
        const result = await tx.order.updateMany({ where: { id: orderId, status: existing.status }, data: { status } });
        if (result.count > 0) changedFields = true;
      } else {
        statusSkippedReason = `Commande Shopify ${order.name} : transition ${existing.status} → ${status} ignorée (déjà en cours de traitement localement).`;
      }
    }

    const wantedPlacedAt = parseOrderPlacedAt(order.createdAt);
    const placedAtChanged = existing.placedAt.getTime() !== wantedPlacedAt.getTime();
    const totalsChanged =
      Number(existing.total) !== fields.total || Number(existing.subtotal) !== fields.subtotal || Number(existing.shippingCost) !== fields.shippingCost;
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

    const refunded = totalRefundedAmount(order);
    if (refunded > 0) {
      const existingRefund = await tx.refund.findFirst({ where: { orderId, source: "SHOPIFY" } });
      if (!existingRefund) {
        await tx.refund.create({ data: { orderId, amount: refunded, reason: "Importé depuis Shopify", status: "COMPLETE", source: "SHOPIFY" } });
        changedFields = true;
      } else if (Number(existingRefund.amount) !== refunded) {
        await tx.refund.update({ where: { id: existingRefund.id }, data: { amount: refunded } });
        changedFields = true;
      }
      if (status === "REMBOURSEE" && existing.paymentStatus !== "REMBOURSE") {
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
      metadata: { source: "SHOPIFY", via: actor.type === "INTEGRATION" ? "webhook_or_sync" : "sync" },
    });
  }

  return changedFields ? { outcome: "updated", reason: statusSkippedReason } : { outcome: "unchanged", reason: statusSkippedReason };
}

/**
 * Bulk order import — the manual "Synchroniser les commandes" action.
 * Skips orders already held (their live edits arrive via the
 * orders/updated webhook, not here), and does at most a bounded amount
 * of real work — new imports (the expensive path: several queries each)
 * and placedAt corrections on already-held orders (cheap: one field)
 * each have their own, much smaller cap — before stopping. Both caps are
 * sized for Vercel's Hobby tier (a hard ~10s wall clock).
 *
 * Where it resumes: Shopify pages newest-first, so a run that always
 * restarted at the beginning would spend most of its time budget
 * re-fetching and skipping already-held pages before reaching new work.
 * The GraphQL cursor it stopped on is persisted to
 * `Integration.config.ordersResumeCursor`, so the next run resumes there
 * — pure API-pagination bookkeeping, matching WooCommerce's
 * `ordersResumePage`. A run that exhausts the whole history clears the
 * cursor, so the next one re-checks from the newest orders.
 */
const MAX_IMPORTS_PER_RUN = 15;
const MAX_PLACED_AT_FIXES_PER_RUN = 40;

export async function syncOrders(
  client: import("../client").ShopifyClient,
  actor: SyncActor,
  integrationId: string
): Promise<SyncSummary> {
  const summary = emptySyncSummary();

  const integration = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
  const config = (integration.config as Record<string, unknown> | null) ?? {};
  const startCursor = typeof config.ordersResumeCursor === "string" ? config.ordersResumeCursor : null;

  let importedThisRun = 0;
  let fixedThisRun = 0;
  let capped = false;
  let resumeCursor: string | null = null;

  for await (const { orders: page, endCursor, hasNextPage } of client.listAllOrders(startCursor)) {
    resumeCursor = hasNextPage ? endCursor : null;

    const held = new Map(
      (
        await prisma.order.findMany({
          where: { source: "SHOPIFY", externalId: { in: page.map((o) => o.id) } },
          select: { id: true, externalId: true, placedAt: true, createdAt: true },
        })
      ).map((r) => [r.externalId, r])
    );

    for (const order of page) {
      const existing = held.get(order.id);
      if (existing) {
        if (existing.placedAt.getTime() !== existing.createdAt.getTime()) {
          summary.unchanged++;
          continue;
        }
        if (fixedThisRun >= MAX_PLACED_AT_FIXES_PER_RUN) {
          capped = true;
          resumeCursor = startCursor;
          break;
        }
        await prisma.order.update({
          where: { id: existing.id },
          data: { placedAt: parseOrderPlacedAt(order.createdAt) },
        });
        fixedThisRun++;
        summary.updated++;
        continue;
      }
      if (importedThisRun >= MAX_IMPORTS_PER_RUN) {
        capped = true;
        resumeCursor = startCursor;
        break;
      }
      try {
        const { outcome, reason } = await importOrder(order, actor);
        summary[outcome]++;
        if (outcome === "imported") importedThisRun++;
        if (reason) recordNote(summary, reason);
      } catch {
        recordNote(summary, `Commande Shopify ${order.name} : échec d'importation.`);
        summary.failed++;
      }
    }
    if (capped) break;
  }

  await prisma.integration.update({
    where: { id: integrationId },
    data: { config: { ...config, ordersResumeCursor: resumeCursor } },
  });

  summary.hasMore = capped;
  if (capped) {
    recordNote(
      summary,
      `Lot traité (max ${MAX_IMPORTS_PER_RUN} nouvelles, ${MAX_PLACED_AT_FIXES_PER_RUN} dates corrigées) — relancez « Synchroniser les commandes » pour continuer.`
    );
  }

  return summary;
}
