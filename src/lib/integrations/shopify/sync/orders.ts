import { applyStorePaymentEvent } from "@/lib/orders/store-payment";
import "server-only";

import { REOPEN_ORDER_DATA, isReopenable } from "@/lib/order-confirmation";
import { packingResetFor } from "@/lib/packing";
import { getDefaultOnlineChannelId } from "@/lib/channels";

import { prisma } from "@/lib/prisma";
import { historicalCutoff, patchIntegrationConfig } from "../../shared/integration-config";
import { recordAuditEvent } from "@/lib/audit";
import { canTransitionOrderStatus, orderHoldsReservation } from "@/lib/validation/order";
import { releaseStockForOrder } from "@/lib/inventory";
import {
  applyCancelledFullRefund,
  heldOrderPaymentFailure,
  importedPaymentStatus,
  orderMixedRefundReview,
  orderReservedUnits,
  reserveForStoreConfirmation,
  storeEventTime,
  storeOrderingRefusal,
  storePaymentRefreshNeeded,
  storeRefreshNeeded,
  storeShipmentReportIsBehind,
  storeTransitionDates,
  toCents,
} from "../../shared/order-sync-rules";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { mapOrderStatus, mapPaymentMethod, totalRefundedAmount } from "../mapper";
import type { ShopifyOrder } from "../types";
import { findOrCreateCustomer } from "@/lib/customers/find-or-create";
import { customerPhoneKey } from "@/lib/customers/identity";
import { actorAuditFields, actorPerformedById, emptySyncSummary, isRecentlyPlaced, parseOrderPlacedAt, recordNote, upsertCustomerAddressFromOrder, type SyncActor, type SyncSummary } from "@/lib/integrations/shared";
import {
  notifyNewOrder,
  checkAndNotifyInsufficientStockForOrder,
  notifyPaymentReview,
  notifyWorkflowMismatch,
  resolveNotifications,
} from "@/lib/notifications";
import { reconcileOrderCommission } from "@/lib/commissions";
import { claimTenantDisplayNumber } from "@/lib/tenant/numbering";
import type { Prisma, OrderStatus } from "@prisma/client";

/**
 * Shopify → System, one direction, always (see docs/adr/0011-shopify-integration.md
 * — mirrors the WooCommerce integration's own reasoning). Shared by the
 * manual "Synchroniser les commandes" action and the orders/create and
 * orders/updated webhook handlers.
 *
 * Stock: same rules as WooCommerce's sync/orders.ts (shared/order-sync-rules.ts,
 * docs/adr/0030 / 0036) — reserved ⟺ CONFIRMEE / EN_PREPARATION and not
 * shipped, whichever side moved the order; a store CONFIRMEE reserves like a
 * human confirmation (or stays NOUVELLE when short), EXPEDIEE is never
 * auto-applied, a demotion releases only what the order's ledger holds.
 *
 * Deliberately NOT done here: reconciling line items on a re-import — a
 * Shopify order's line items are fixed at placement; a re-import only
 * refreshes order-level fields (status where the transition is valid,
 * totals, customer snapshot, refund state).
 */
export interface ImportOrderOptions {
  /** See WooCommerce's identical option
   * (`src/lib/integrations/woocommerce/sync/orders.ts`) — same
   * `Integration.config.forceNouvelleOnImport` client preference, same
   * "only the NOUVELLE → CONFIRMEE transition is ever blocked" rule,
   * enforced on every import AND every later re-sync/webhook update
   * (2026-09-13 fix), and on by DEFAULT (only an explicit `false` opts
   * out). */
  forceNouvelleOnFirstImport?: boolean;
}

export async function importOrder(
  order: ShopifyOrder,
  actor: SyncActor,
  options?: ImportOrderOptions
): Promise<{ outcome: "imported" | "updated" | "unchanged" | "skipped"; reason?: string }> {
  const statusMapping = mapOrderStatus(order.displayFinancialStatus, order.displayFulfillmentStatus, order.cancelledAt);
  if (!statusMapping.ok) {
    // An order we already hold, now in a combination we cannot map (e.g. a
    // partial refund on an unshipped order): its status is left alone, but
    // its amounts and refunds are still refreshed — never dropped while the
    // delivery is counted as handled. Partial stays partial: `paymentStatus`
    // only becomes REMBOURSE on Shopify's own REFUNDED.
    const held = await prisma.order.findFirst({ where: { source: "SHOPIFY", externalId: order.id }, select: { id: true, status: true } });
    if (held) {
      const result = await updateExistingOrder(held.id, order, held.status, actor, options, { keepCurrentStatus: true });
      return { ...result, reason: `${statusMapping.reason} Statut inchangé ; montants et remboursements mis à jour.` };
    }
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

  // A store PAYMENT failure (EXPIRED) never moves an order we already hold:
  // only its payment status (decisions §1, `heldOrderPaymentFailure`).
  const paymentFailed = statusMapping.paymentFailed === true;
  if (existing) {
    return updateExistingOrder(existing.id, order, statusMapping.status, actor, options, { keepCurrentStatus: paymentFailed, paymentFailed });
  }

  const forcedToNouvelle = Boolean(options?.forceNouvelleOnFirstImport) && statusMapping.status === "CONFIRMEE";
  // A status needing a stock transition is never written straight onto a new
  // order (see WooCommerce's importOrder): created NOUVELLE, then the update
  // path applies it with its guards — CONFIRMEE reserves or stays NOUVELLE,
  // EXPEDIEE (Shopify IN_PROGRESS / PARTIALLY_FULFILLED) is never auto-applied.
  const viaTransition = !forcedToNouvelle && (orderHoldsReservation(statusMapping.status) || statusMapping.status === "EXPEDIEE");
  const effectiveStatus: OrderStatus = forcedToNouvelle || viaTransition ? "NOUVELLE" : statusMapping.status;

  try {
    const created = await createImportedOrder(order, effectiveStatus, customerId, actor, forcedToNouvelle ? true : undefined, paymentFailed);
    if (!viaTransition) return { outcome: "imported" };
    // Right after creation: the « nouvelle commande » alert just sent stays (ADR 0016).
    const transition = await updateExistingOrder(created.orderId, order, statusMapping.status, actor, options, { keepNewOrderAlert: true });
    return { outcome: "imported", reason: transition.reason };
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
      if (winner) return updateExistingOrder(winner.id, order, statusMapping.status, actor, options, { keepCurrentStatus: paymentFailed, paymentFailed });
    }
    throw error;
  }
}

function fullName(first?: string | null, last?: string | null): string {
  return [first, last].filter(Boolean).join(" ").trim();
}

/**
 * Customer of an imported order — same rule as the WooCommerce import: a
 * Shopify account already linked to a customer → that customer, refreshed;
 * otherwise findOrCreateCustomer (same normalized name + phone, else new).
 */
async function resolveCustomerForOrder(order: ShopifyOrder, actor: SyncActor): Promise<string> {
  const email = order.customer?.email ?? order.email ?? null;
  const address = order.shippingAddress ?? order.billingAddress;
  const name =
    fullName(order.customer?.firstName, order.customer?.lastName) ||
    fullName(address?.firstName, address?.lastName) ||
    email ||
    `Client Shopify ${order.name}`;
  const phone = order.customer?.phone ?? order.phone ?? address?.phone ?? null;
  const externalId = order.customer?.id ?? null;

  const fields = {
    fullName: name,
    email,
    phone,
    city: address?.city ?? null,
    region: address?.province ?? null,
    country: address?.country ?? "Maroc",
  };

  if (externalId) {
    const linked = await prisma.customer.findFirst({
      where: { source: "SHOPIFY", externalId },
      select: { id: true },
    });
    if (linked) {
      await prisma.customer.update({
        where: { id: linked.id },
        data: { ...fields, phoneKey: customerPhoneKey(phone) },
      });
      return linked.id;
    }
  }

  const { customer, reused } = await findOrCreateCustomer({ ...fields, source: "SHOPIFY", externalId });
  if (reused) return customer.id;

  await recordAuditEvent({
    ...actorAuditFields(actor),
    action: "customer.created",
    entityType: "Customer",
    entityId: customer.id,
    newValue: { fullName: customer.fullName },
    metadata: { source: "SHOPIFY" },
  });

  return customer.id;
}

function mappedOrderFields(order: ShopifyOrder) {
  const address = order.shippingAddress ?? order.billingAddress;
  const recipient =
    [address?.firstName, address?.lastName].filter(Boolean).join(" ").trim() ||
    [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(" ").trim();
  return {
    subtotal: order.subtotalPriceSet.amount,
    discountTotal: order.totalDiscountsSet?.amount ?? 0,
    shippingCost: order.totalShippingPriceSet.amount,
    total: order.currentTotalPriceSet.amount,
    currency: order.currentTotalPriceSet.currency,
    shippingName: recipient || null,
    shippingAddressLine1: address?.address1 ?? null,
    shippingAddressLine2: address?.address2 ?? null,
    shippingCity: address?.city ?? null,
    shippingRegion: address?.province ?? null,
    // Empty / MA / Morocco → "Maroc" — the app's only market.
    shippingCountry: /^(|ma|mar|maroc|morocco)$/i.test((address?.country ?? "").trim()) ? "Maroc" : address!.country!,
    shippingPhone: address?.phone ?? null,
    notes: order.note?.trim() || null,
  };
}

async function createImportedOrder(
  order: ShopifyOrder,
  status: OrderStatus,
  customerId: string,
  actor: SyncActor,
  /** True only when `forceNouvelleOnFirstImport` downgraded CONFIRMEE to
   * NOUVELLE — recorded on the audit event so staff can see why an
   * already-paid/processing order didn't land as Confirmée. */
  forcedNouvelleFromConfirmee?: boolean,
  /** Shopify reports a failed PAYMENT (EXPIRED): imported NOUVELLE with paymentStatus ECHEC. */
  paymentFailed = false
): Promise<{ outcome: "imported"; orderId: string }> {
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
      paymentStatus: importedPaymentStatus({ paymentFailed, refundedStatus: status === "REMBOURSEE", paid: order.displayFinancialStatus === "PAID" }),
      paymentMethod: mapPaymentMethod(order.paymentGatewayNames),
      source: "SHOPIFY",
      // Business channel (docs/adr/0038) — see the WooCommerce importer.
      salesChannelId: await getDefaultOnlineChannelId(),
      externalId: order.id,
      externalNumber: order.name,
      placedAt: parseOrderPlacedAt(order.createdAt),
      subtotal: fields.subtotal,
      discountTotal: fields.discountTotal,
      shippingCost: fields.shippingCost,
      total: fields.total,
      currency: fields.currency,
      shippingName: fields.shippingName,
      shippingAddressLine1: fields.shippingAddressLine1,
      shippingAddressLine2: fields.shippingAddressLine2,
      shippingCity: fields.shippingCity,
      shippingRegion: fields.shippingRegion,
      shippingCountry: fields.shippingCountry,
      shippingPhone: fields.shippingPhone,
      notes: fields.notes,
      // A store LIVREE / ANNULEE carries its date like a manual transition.
      ...storeTransitionDates(status, { deliveredAt: null, cancelledAt: null }, storeEventTimes(order)),
      items: { create: items },
    },
  });
  const displayNumber = await claimTenantDisplayNumber(prisma, createdOrder.tenantId, "order");
  await prisma.order.update({ where: { id: createdOrder.id }, data: { displayNumber } });

  const refunded = totalRefundedAmount(order);
  if (refunded > 0) {
    await prisma.refund.create({
      data: { orderId: createdOrder.id, amount: refunded, reason: "Importé depuis Shopify", status: "COMPLETE", source: "SHOPIFY" },
    });
    // Imported already cancelled AND fully refunded → payment REMBOURSE (decisions §3).
    await prisma.$transaction((tx) => applyCancelledFullRefund(tx, createdOrder.id));
  }

  await recordAuditEvent({
    ...actorAuditFields(actor),
    action: "order.created",
    entityType: "Order",
    entityId: createdOrder.id,
    // An imported payment failure is recorded with the store's own time: a
    // later « paid » report is ordered against it (applyStorePaymentEvent).
    newValue: { total: fields.total.toString(), customerId, ...(createdOrder.paymentStatus === "ECHEC" ? { paymentStatus: "ECHEC" } : {}) },
    metadata: {
      ...(createdOrder.paymentStatus === "ECHEC" ? { storeModifiedAt: storeEventTimes(order).modified?.toISOString() ?? null } : {}),
      source: "SHOPIFY",
      externalId: createdOrder.externalId,
      ...(forcedNouvelleFromConfirmee ? { forcedNouvelleFromConfirmee: true } : {}),
    },
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
        displayNumber,
        total: fields.total,
        currency: fields.currency,
        customerName: customer.fullName,
        source: "SHOPIFY",
      },
      actorPerformedById(actor)
    );
  }

  // Read-only alert — never blocks the import and never touches stock.
  // Same recency guard as notifyNewOrder above: a first-time historical
  // sync of hundreds of old orders doesn't flood hundreds of alerts.
  if (actor.type === "INTEGRATION" || isRecentlyPlaced(order.createdAt)) {
    await checkAndNotifyInsufficientStockForOrder(
      {
        id: createdOrder.id,
        orderNumber: createdOrder.orderNumber,
        displayNumber,
        source: "SHOPIFY",
        externalNumber: createdOrder.externalNumber,
      },
      items.map((i) => ({ productId: i.productId, variationId: i.variationId, quantity: i.quantity }))
    );
  }

  return { outcome: "imported", orderId: createdOrder.id };
}

/** Shopify's own event times for this order: last modification, cancellation. */
function storeEventTimes(order: ShopifyOrder): { modified: Date | null; delivered: Date | null; cancelled: Date | null } {
  const modified = storeEventTime(order.updatedAt);
  return { modified, delivered: modified, cancelled: storeEventTime(order.cancelledAt) ?? modified };
}

async function updateExistingOrder(
  orderId: string,
  order: ShopifyOrder,
  status: OrderStatus,
  actor: SyncActor,
  options?: ImportOrderOptions,
  internal: {
    keepNewOrderAlert?: boolean;
    /** Leave the status as it is under the lock (unmappable combination, store payment failure). */
    keepCurrentStatus?: boolean;
    /** Shopify reports a failed PAYMENT (EXPIRED): EN_ATTENTE → ECHEC, status untouched. */
    paymentFailed?: boolean;
  } = {}
): Promise<{ outcome: "updated" | "unchanged"; reason?: string }> {
  const existing = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const fields = mappedOrderFields(order);
  const label = `Commande Shopify ${order.name}`;
  const eventTimes = storeEventTimes(order);
  let changedFields = false;
  let statusSkippedReason: string | undefined;
  let workflowMismatch: string | undefined;
  /** A payment / refund fact left for a person (decision 2026-10-14 bis) — alerted, nothing changed. */
  let paymentReview: string | null = null;
  /** The order's status as read UNDER the row lock (another delivery may have moved it since `existing`). */
  let previousStatus: OrderStatus = existing.status;

  await prisma.$transaction(async (tx) => {
    // One delivery at a time per order (e.g. refunds/create racing
    // orders/updated): the refund find-then-create below and the stock
    // release see the previous delivery's committed result — never two
    // « Importé depuis …» refunds, never a double release.
    await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${orderId} FOR UPDATE`;
    const current = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true, paymentStatus: true, shippedAt: true, confirmedAt: true, cancelledAt: true, deliveredAt: true },
    });
    previousStatus = current.status;
    // Read under the lock: never a transition computed from a stale status.
    if (internal.keepCurrentStatus) status = current.status;
    // Shopify reports shipped / FULFILLED while ASODITECH is already at or past
    // its own shipment (delivered by the carrier or staff, returned, …): the
    // store is simply behind — nothing changes, no false alert (decisions §2).
    if (status === "EXPEDIEE" && storeShipmentReportIsBehind(current.status)) status = current.status;
    if (current.status !== status) {
      // Same rule as first import, now enforced on every later re-sync/
      // webhook update too (2026-09-13 fix) — see the identical comment in
      // WooCommerce's sync/orders.ts for the full reasoning.
      const autoConfirmBlocked =
        current.status === "NOUVELLE" && status === "CONFIRMEE" && options?.forceNouvelleOnFirstImport !== false;
      // ASODITECH's own EXPEDIEE transition is the ONLY physical
      // -fulfillment event, for every order source (docs/adr/0036-inventory
      // -single-source-of-truth.md) — a Shopify fulfillment status (e.g.
      // IN_PROGRESS/PARTIALLY_FULFILLED, which `mapOrderStatus` maps to
      // EXPEDIEE) must never auto-apply locally. Letting it through here
      // would (at best) release a reservation without ever running
      // fulfillStockForOrder — corrupting on-hand — and at worst skip the
      // physical-fulfillment step entirely. Surface a workflow mismatch
      // instead; a human validates the shipment inside ASODITECH itself.
      const expedieeAutoAdvanceBlocked = status === "EXPEDIEE" && current.status !== "EXPEDIEE";
      // Same rule as « Rétablir la commande »: a shipped order never reopens.
      const reopenBlocked = status === "NOUVELLE" && current.status === "ANNULEE" && !isReopenable(current);
      // A stale snapshot never undoes a newer local confirmation / cancellation.
      const orderingRefusal = storeOrderingRefusal(label, status, current, eventTimes.modified);
      if (autoConfirmBlocked) {
        statusSkippedReason = `Commande Shopify ${order.name} : reste "Nouvelle" — confirmation manuelle requise avant "Confirmée" (réglage "Toujours importer en Nouvelle").`;
      } else if (expedieeAutoAdvanceBlocked) {
        statusSkippedReason = `Commande Shopify ${order.name} : le statut d'exécution Shopify indique une expédition, mais seule l'action "Expédiée" dans ASODITECH peut faire progresser la commande et consommer le stock.`;
        workflowMismatch = `${order.displayFulfillmentStatus ?? "?"} (exécution) / ${order.displayFinancialStatus ?? "?"} (paiement)`;
      } else if (reopenBlocked) {
        statusSkippedReason = `Commande Shopify ${order.name} : déjà expédiée — elle ne peut pas revenir à "Nouvelle" depuis "Annulée".`;
      } else if (orderingRefusal) {
        statusSkippedReason = orderingRefusal.reason;
        // Within the clock tolerance / order unknown: a person decides — alerted.
        if (orderingRefusal.kind === "review") {
          workflowMismatch = `${order.displayFulfillmentStatus ?? "?"} (exécution) / ${order.displayFinancialStatus ?? "?"} (paiement)`;
        }
      } else if (
        canTransitionOrderStatus(current.status, status) &&
        // Entering a reservation-holding status: same strict reservation as a
        // human confirmation, first, in this transaction (see WooCommerce's).
        (!orderHoldsReservation(status) ||
          orderHoldsReservation(current.status) ||
          current.shippedAt !== null ||
          (await reserveForStoreConfirmation(tx, orderId, actorPerformedById(actor))) === "reserved")
      ) {
        // ANNULEE → NOUVELLE resets the current confirmation state (docs/adr/0049).
        const result = await tx.order.updateMany({
          where: { id: orderId, status: current.status },
          data:
            status === "NOUVELLE"
              ? REOPEN_ORDER_DATA
              : { status, ...packingResetFor(status), ...storeTransitionDates(status, current, eventTimes) },
        });
        if (result.count === 0) throw new Error(`${label} : statut modifié pendant la synchronisation.`);
        if (result.count > 0) {
          changedFields = true;
          // 2026-09-13 fix — see the identical comment in WooCommerce's
          // sync/orders.ts for the full reasoning: keep the reservation
          // ledger honest regardless of which side drove the demotion.
          // Reservation-only (never quantityOnHand); this function still
          // never reserves or fulfills.
          // Same rule as the manual cancel (src/actions/orders.ts `wasFulfilled`,
          // docs/adr/0036): an order already shipped once (`shippedAt` set,
          // e.g. EXPEDIEE → ECHEC → EN_PREPARATION retry) holds no
          // reservation any more — releasing would eat another order's.
          if (
            current.shippedAt === null &&
            orderHoldsReservation(current.status) &&
            !orderHoldsReservation(status) &&
            (await orderReservedUnits(tx, orderId)) > 0
          ) {
            const items = await tx.orderItem.findMany({
              where: { orderId },
              select: { productId: true, variationId: true, quantity: true },
            });
            await releaseStockForOrder(tx, orderId, items, actorPerformedById(actor));
          }
        }
      } else if (canTransitionOrderStatus(current.status, status)) {
        statusSkippedReason = `${label} : stock insuffisant pour réserver — la commande reste "${current.status}" ; confirmez-la dans ASODITECH.`;
      } else {
        statusSkippedReason = `Commande Shopify ${order.name} : transition ${current.status} → ${status} ignorée (déjà en cours de traitement localement).`;
        // A terminal/further-along external status than ASODITECH's own
        // current stage is a genuine workflow disagreement worth a human's
        // attention (docs/adr/0036) — not merely a sync-summary footnote.
        if (status === "LIVREE" || status === "REMBOURSEE" || status === "ANNULEE") {
          workflowMismatch = `${order.displayFulfillmentStatus ?? "?"} (exécution) / ${order.displayFinancialStatus ?? "?"} (paiement)`;
        }
      }
    }

    const wantedPlacedAt = parseOrderPlacedAt(order.createdAt);
    const placedAtChanged = existing.placedAt.getTime() !== wantedPlacedAt.getTime();
    const totalsChanged =
      Number(existing.total) !== fields.total || Number(existing.subtotal) !== fields.subtotal || Number(existing.shippingCost) !== fields.shippingCost;
    if (
      totalsChanged ||
      existing.notes !== fields.notes ||
      placedAtChanged ||
      existing.shippingName !== fields.shippingName
    ) {
      await tx.order.update({
        where: { id: orderId },
        data: {
          placedAt: wantedPlacedAt,
          subtotal: fields.subtotal,
          discountTotal: fields.discountTotal,
          shippingCost: fields.shippingCost,
          total: fields.total,
          shippingName: fields.shippingName,
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
      } else if (toCents(existingRefund.amount) !== toCents(refunded)) {
        await tx.refund.update({ where: { id: existingRefund.id }, data: { amount: refunded } });
        changedFields = true;
      }
      // A refund recorded by hand next to the store's: possibly the same
      // money — never netted automatically, a person checks.
      if (changedFields) paymentReview = await orderMixedRefundReview(tx, orderId, label);
      if (status === "REMBOURSEE" && existing.paymentStatus !== "REMBOURSE") {
        await tx.order.update({ where: { id: orderId }, data: { paymentStatus: "REMBOURSE" } });
        changedFields = true;
      }
    }

    // Store PAYMENT failure (decisions §1): only a payment still EN_ATTENTE
    // becomes ECHEC; the order's status is never touched by it.
    if (internal.paymentFailed) {
      const failed = heldOrderPaymentFailure(current.paymentStatus);
      if (failed) {
        const result = await tx.order.updateMany({ where: { id: orderId, paymentStatus: current.paymentStatus }, data: { paymentStatus: failed } });
        if (result.count > 0) {
          // Audited with the store's own time: a later « paid » report is
          // ordered against it (applyStorePaymentEvent).
          await recordAuditEvent(
            {
              ...actorAuditFields(actor),
              action: "order.updated",
              entityType: "Order",
              entityId: orderId,
              previousValue: { paymentStatus: current.paymentStatus },
              newValue: { paymentStatus: failed },
              metadata: { reason: "store_reported_payment_failed", source: "SHOPIFY", storeModifiedAt: eventTimes.modified?.toISOString() ?? null },
            },
            tx
          );
          changedFields = true;
        }
      }
    }

    // Cancelled and fully refunded (decisions §3): status stays ANNULEE, payment REMBOURSE.
    if (await applyCancelledFullRefund(tx, orderId)) changedFields = true;

    // « Paiement confirmé par la boutique » (opt-in, default off): the store
    // now reports this order paid → EN_ATTENTE (or, clearly after the
    // recorded failure, ECHEC) becomes PAYE, audited on its own. Payment
    // only — the order's status, stock and shipment are never touched.
    // Never from a carrier status; never while the store reports a refund.
    if (refunded <= 0) {
      const payment = await applyStorePaymentEvent(orderId, order.displayFinancialStatus === "PAID", "SHOPIFY", tx, {
        storeModifiedAt: eventTimes.modified,
        paymentFailed: internal.paymentFailed,
        label,
      });
      if (payment.changed) changedFields = true;
      if (payment.refusal) {
        statusSkippedReason = statusSkippedReason ? `${statusSkippedReason} ${payment.refusal.reason}` : payment.refusal.reason;
        if (payment.refusal.kind === "review") paymentReview ??= payment.refusal.reason;
      }
    }
  });

  if (paymentReview) {
    await notifyPaymentReview({ id: orderId, orderNumber: existing.orderNumber, displayNumber: existing.displayNumber }, paymentReview);
  }

  if (changedFields) {
    await recordAuditEvent({
      ...actorAuditFields(actor),
      action: "order.updated",
      entityType: "Order",
      entityId: orderId,
      metadata: { source: "SHOPIFY", via: actor.type === "INTEGRATION" ? "webhook_or_sync" : "sync" },
    });
  }

  if (previousStatus === "NOUVELLE" && status !== "NOUVELLE" && !internal.keepNewOrderAlert) {
    await resolveNotifications({ types: ["NOUVELLE_COMMANDE"], entityType: "Order", entityId: orderId });
  }
  if (workflowMismatch) {
    await notifyWorkflowMismatch({
      id: orderId,
      orderNumber: existing.orderNumber,
      displayNumber: existing.displayNumber,
      source: "SHOPIFY",
      externalNumber: order.name,
      localStatus: previousStatus,
      externalStatus: workflowMismatch,
    });
  }
  if (previousStatus !== status && (status === "LIVREE" || previousStatus === "LIVREE")) {
    await reconcileOrderCommission(orderId);
  }

  return changedFields ? { outcome: "updated", reason: statusSkippedReason } : { outcome: "unchanged", reason: statusSkippedReason };
}

/**
 * Bulk order import — the manual "Synchroniser les commandes" action.
 * Imports new orders AND refreshes held orders whose Shopify state differs
 * (status, totals, refunds), through the same update path as a webhook
 * (`storeRefreshNeeded`), with at most a bounded amount of work — new
 * imports, refreshes and placedAt corrections each have their own cap —
 * before stopping. Both caps are
 * sized for Vercel's Hobby tier (a hard ~10s wall clock).
 *
 * Where it resumes: Shopify pages newest-first (`reverse: true` in the client), so a run that always
 * restarted at the beginning would spend most of its time budget
 * re-fetching and skipping already-held pages before reaching new work.
 * The GraphQL cursor it stopped on is persisted to
 * `Integration.config.ordersResumeCursor`, so the next run resumes there
 * — pure API-pagination bookkeeping, matching WooCommerce's
 * `ordersResumePage`. A run that exhausts the whole history clears the
 * cursor, so the next one re-checks from the newest orders.
 */
const MAX_IMPORTS_PER_RUN = 15;
const MAX_REFRESHES_PER_RUN = 15;
const MAX_PLACED_AT_FIXES_PER_RUN = 40;

export async function syncOrders(
  client: import("../client").ShopifyClient,
  actor: SyncActor,
  integrationId: string
): Promise<SyncSummary> {
  const summary = emptySyncSummary();

  const integration = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
  const config = (integration.config as Record<string, unknown> | null) ?? {};
  // A cursor saved before the switch to newest-first paging belongs to the
  // old (oldest-first) ordering: ignored, the scan restarts from the newest.
  const startCursor =
    typeof config.ordersResumeCursor === "string" && config.ordersCursorOrder === "newest" ? config.ordersResumeCursor : null;
  // On by default — see ImportOrderOptions's doc comment. `false` is the
  // only value that opts out; unset/anything else keeps the safe default.
  const forceNouvelleOnFirstImport = config.forceNouvelleOnImport !== false;
  // « Paiement confirmé par la boutique »: a held failed payment the store now reports paid is refreshed only when it is on.
  const autoPaymentFromStore = (await prisma.businessSettings.findFirst({ select: { autoPaymentFromStore: true } }))?.autoPaymentFromStore ?? false;
  // « Importer l'historique » OFF — see WooCommerce's syncOrders.
  const cutoff = historicalCutoff(config);

  let importedThisRun = 0;
  let refreshedThisRun = 0;
  let reachedCutoff = false;
  // The cursor that fetched the page being processed: a run capped inside
  // a page resumes AT that page next time (not at the run's first page).
  let pageStartCursor: string | null = startCursor;
  let fixedThisRun = 0;
  let capped = false;
  let resumeCursor: string | null = null;

  for await (const { orders: page, endCursor, hasNextPage } of client.listAllOrders(startCursor)) {
    resumeCursor = hasNextPage ? endCursor : null;

    const held = new Map(
      (
        await prisma.order.findMany({
          where: { source: "SHOPIFY", externalId: { in: page.map((o) => o.id) } },
          select: {
            id: true,
            externalId: true,
            placedAt: true,
            createdAt: true,
            status: true,
            total: true,
            paymentStatus: true,
            confirmedAt: true,
            cancelledAt: true,
            refunds: { where: { source: "SHOPIFY" }, select: { amount: true } },
          },
        })
      ).map((r) => [r.externalId, r])
    );

    for (const order of page) {
      if (cutoff && parseOrderPlacedAt(order.createdAt) < cutoff) {
        reachedCutoff = true;
        resumeCursor = null;
        break;
      }
      const existing = held.get(order.id);
      if (existing) {
        // ADR 0010/0011/0030: a later manual sync refreshes held orders too
        // (see WooCommerce's syncOrders and `storeRefreshNeeded`).
        const mapped = mapOrderStatus(order.displayFinancialStatus, order.displayFulfillmentStatus, order.cancelledAt);
        const paymentFailed = mapped.ok && mapped.paymentFailed === true;
        const needsRefresh = storePaymentRefreshNeeded(paymentFailed, existing.paymentStatus, { storeReportsPaid: order.displayFinancialStatus === "PAID", autoPaymentFromStore }) || storeRefreshNeeded({
          held: {
            status: existing.status,
            total: Number(existing.total),
            refunded: existing.refunds.reduce((sum, r) => sum + Number(r.amount), 0),
            confirmedAt: existing.confirmedAt,
            cancelledAt: existing.cancelledAt,
          },
          // A payment failure never changes a held order's status.
          mappedStatus: mapped.ok && !paymentFailed ? mapped.status : null,
          storeTotal: mappedOrderFields(order).total,
          storeRefunded: totalRefundedAmount(order),
          storeModifiedAt: storeEventTimes(order).modified,
          forceNouvelleOnFirstImport,
          canTransition: canTransitionOrderStatus,
        });
        if (needsRefresh) {
          if (refreshedThisRun >= MAX_REFRESHES_PER_RUN) {
            capped = true;
            resumeCursor = pageStartCursor;
            break;
          }
          refreshedThisRun++;
          try {
            const { outcome, reason } = await importOrder(order, actor, { forceNouvelleOnFirstImport });
            summary[outcome]++;
            if (reason) recordNote(summary, reason);
          } catch {
            recordNote(summary, `Commande Shopify ${order.name} : échec de la mise à jour.`);
            summary.failed++;
          }
          continue;
        }
        if (existing.placedAt.getTime() !== existing.createdAt.getTime()) {
          summary.unchanged++;
          continue;
        }
        if (fixedThisRun >= MAX_PLACED_AT_FIXES_PER_RUN) {
          capped = true;
          resumeCursor = pageStartCursor;
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
        resumeCursor = pageStartCursor;
        break;
      }
      try {
        const { outcome, reason } = await importOrder(order, actor, { forceNouvelleOnFirstImport });
        summary[outcome]++;
        if (outcome === "imported") importedThisRun++;
        if (reason) recordNote(summary, reason);
      } catch {
        recordNote(summary, `Commande Shopify ${order.name} : échec d'importation.`);
        summary.failed++;
      }
    }
    if (capped || reachedCutoff) break;
    pageStartCursor = endCursor;
    // Saved after every page, only this key, atomically (see WooCommerce).
    await patchIntegrationConfig(integrationId, { ordersResumeCursor: resumeCursor, ordersCursorOrder: "newest" });
  }

  await patchIntegrationConfig(integrationId, { ordersResumeCursor: resumeCursor, ordersCursorOrder: "newest" });

  summary.hasMore = capped;
  if (capped) {
    recordNote(
      summary,
      `Lot traité (max ${MAX_IMPORTS_PER_RUN} nouvelles, ${MAX_REFRESHES_PER_RUN} mises à jour, ${MAX_PLACED_AT_FIXES_PER_RUN} dates corrigées) — relancez « Synchroniser les commandes » pour continuer.`
    );
  }
  if (reachedCutoff) {
    recordNote(summary, "Historique non importé (réglage « Importer l'historique des commandes » désactivé) : les commandes antérieures à la date choisie sont ignorées.");
  }

  return summary;
}
