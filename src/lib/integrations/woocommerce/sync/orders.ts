import { applyStorePaymentEvent } from "@/lib/orders/store-payment";
import "server-only";

import { REOPEN_ORDER_DATA, isReopenable } from "@/lib/order-confirmation";
import { packingResetFor } from "@/lib/packing";
import { getDefaultOnlineChannelId } from "@/lib/channels";

import { prisma } from "@/lib/prisma";
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
  storeTransitionDates,
  toCents,
} from "../../shared/order-sync-rules";
import { isUnsupportedOrderStatus, mapCustomerFieldsFromOrder, mapOrderFields, mapOrderStatus, mapPaymentMethod, totalRefundedAmount } from "../mapper";
import { historicalCutoff, patchIntegrationConfig, unsupportedStatusNote } from "../../shared/integration-config";
import { findOrCreateCustomer } from "@/lib/customers/find-or-create";
import { customerPhoneKey } from "@/lib/customers/identity";
import type { WcOrder } from "../types";
import { actorAuditFields, actorPerformedById, type SyncActor } from "./actor";
import { isRecentlyPlaced, parseOrderPlacedAt } from "../../shared/order-recency";
import { upsertCustomerAddressFromOrder } from "../../shared/customer-address";
import {
  notifyNewOrder,
  checkAndNotifyInsufficientStockForOrder,
  notifyPaymentReview,
  notifyWorkflowMismatch,
  resolveNotifications,
} from "@/lib/notifications";
import { reconcileOrderCommission } from "@/lib/commissions";
import { claimTenantDisplayNumber } from "@/lib/tenant/numbering";
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
 * Stock (docs/adr/0030 / 0036, shared/order-sync-rules.ts): an order holds a
 * reservation ⟺ CONFIRMEE / EN_PREPARATION and not shipped, whichever side
 * moved it. A store status that would need a stock transition is never
 * written straight onto a new order: CONFIRMEE (only with « Toujours
 * importer en Nouvelle » off) goes through the update path, which takes the
 * same strict reservation a human confirmation takes — or keeps the order
 * NOUVELLE with a reason when stock is short; EXPEDIEE is never auto-applied.
 * A store demotion releases only what the order's own ledger still holds.
 * Never fulfils (EXPEDIEE is ASODITECH's own action) and never touches
 * on-hand.
 *
 * Deliberately NOT done here: reconciling OrderItems on a re-import. A WC
 * order's line items are fixed at placement; a re-import (webhook
 * order.updated, or a later manual sync) only refreshes order-level fields
 * (status where the transition is valid, totals, customer snapshot,
 * refund state) — never rewrites line items already recorded.
 */
export interface ImportOrderOptions {
  /**
   * `Integration.config.forceNouvelleOnImport` — on by DEFAULT since
   * 2026-09-13 (was opt-in, default off): a first-time import that would
   * otherwise land as CONFIRMEE (WooCommerce "processing") is created as
   * NOUVELLE instead, so the confirmation team always phones the customer
   * before the order is treated as confirmed — even though WooCommerce
   * itself already considers it paid/processing. This is the intended
   * ASODITECH workflow, not an edge case: import → NOUVELLE, a human
   * confirms inside ASODITECH → CONFIRMEE (which is what actually reserves
   * stock — see reserveStockForOrder). A tenant that genuinely wants to
   * trust WooCommerce's own "processing" status directly can still opt out
   * by explicitly setting `forceNouvelleOnImport: false` (the
   * ForceNouvelleToggle UI).
   *
   * Enforced on every import AND every later re-sync/webhook update of an
   * already-held order (2026-09-13 fix — see updateExistingOrder): the
   * gap where order.created landed an order as NOUVELLE (WC "pending") but
   * a LATER order.updated reporting "processing" silently promoted it to
   * CONFIRMEE was the exact same "never auto-confirm" rule being violated
   * one event later. Only the specific NOUVELLE → CONFIRMEE transition is
   * ever blocked by this — every other mapped status/transition (LIVREE,
   * ANNULEE, REMBOURSEE, ECHEC, and CONFIRMEE moving on to EN_PREPARATION/
   * EXPEDIEE/etc.) is never touched by this.
   */
  forceNouvelleOnFirstImport?: boolean;
}

export async function importOrder(
  wc: WcOrder,
  actor: SyncActor,
  options?: ImportOrderOptions
): Promise<{ outcome: "imported" | "updated" | "unchanged" | "skipped"; reason?: string }> {
  const statusMapping = mapOrderStatus(wc.status);
  if (!statusMapping.ok) {
    // An order we already hold, now in a status we cannot map: its status is
    // left alone, but its amounts and refunds are still refreshed — a refund
    // is never dropped while the delivery is counted as handled.
    const held = await prisma.order.findFirst({ where: { source: "WOOCOMMERCE", externalId: String(wc.id) }, select: { id: true, status: true } });
    if (held) {
      const result = await updateExistingOrder(held.id, wc, held.status, actor, options, { keepCurrentStatus: true });
      return { ...result, reason: `${statusMapping.reason} Statut inchangé ; montants et remboursements mis à jour.` };
    }
    return { outcome: "skipped", reason: statusMapping.reason };
  }

  const customerId = await resolveCustomerForOrder(wc, actor);

  // Same shipping-falls-back-to-billing rule as mapOrderFields' own order
  // snapshot — copied into the customer's own address book (see
  // upsertCustomerAddressFromOrder's doc comment) so their Clients page
  // shows a real address instead of "Aucune adresse enregistrée".
  const shippingSource = wc.shipping.address_1 ? wc.shipping : wc.billing;
  await upsertCustomerAddressFromOrder(customerId, {
    addressLine1: shippingSource.address_1?.trim() || null,
    addressLine2: shippingSource.address_2?.trim() || null,
    city: shippingSource.city?.trim() || null,
    region: shippingSource.state?.trim() || null,
    country: shippingSource.country?.trim() || null,
    phone: wc.billing.phone?.trim() || null,
  });

  const externalId = String(wc.id);
  const existing = await prisma.order.findFirst({ where: { source: "WOOCOMMERCE", externalId } });

  // A store PAYMENT failure (`failed`) never moves an order we already hold:
  // only its payment status (decisions §1, `heldOrderPaymentFailure`).
  const paymentFailed = statusMapping.paymentFailed === true;
  if (existing) {
    return updateExistingOrder(existing.id, wc, statusMapping.status, actor, options, { keepCurrentStatus: paymentFailed, paymentFailed });
  }

  const forcedToNouvelle = Boolean(options?.forceNouvelleOnFirstImport) && statusMapping.status === "CONFIRMEE";
  // A status needing a stock transition is never written straight onto a new
  // order: created NOUVELLE, then the update path applies it with its guards.
  const viaTransition = !forcedToNouvelle && (orderHoldsReservation(statusMapping.status) || statusMapping.status === "EXPEDIEE");
  const effectiveStatus: OrderStatus = forcedToNouvelle || viaTransition ? "NOUVELLE" : statusMapping.status;

  try {
    const created = await createImportedOrder(wc, effectiveStatus, customerId, actor, forcedToNouvelle ? wc.status : undefined, paymentFailed);
    if (!viaTransition) return { outcome: "imported" };
    // Right after creation: the « nouvelle commande » alert just sent stays (ADR 0016).
    const transition = await updateExistingOrder(created.orderId, wc, statusMapping.status, actor, options, { keepNewOrderAlert: true });
    return { outcome: "imported", reason: transition.reason };
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
      if (winner) return updateExistingOrder(winner.id, wc, statusMapping.status, actor, options, { keepCurrentStatus: paymentFailed, paymentFailed });
    }
    throw error;
  }
}

/**
 * Customer of an imported order. A real WooCommerce account (customer_id > 0)
 * already linked to a customer → that customer, refreshed from the order.
 * Otherwise (guest checkouts, a first order) → findOrCreateCustomer: the
 * existing customer with the same normalized name + phone, whatever created
 * it, else a new one. No e-mail-only or phone-only matching: same phone with
 * another name is another person.
 */
async function resolveCustomerForOrder(wc: WcOrder, actor: SyncActor): Promise<string> {
  const fields = mapCustomerFieldsFromOrder(wc);
  const externalId = wc.customer_id > 0 ? String(wc.customer_id) : null;

  if (externalId) {
    const linked = await prisma.customer.findFirst({
      where: { source: "WOOCOMMERCE", externalId },
      select: { id: true },
    });
    if (linked) {
      await prisma.customer.update({
        where: { id: linked.id },
        data: { ...fields, phoneKey: customerPhoneKey(fields.phone) },
      });
      return linked.id;
    }
  }

  const { customer, reused } = await findOrCreateCustomer({ ...fields, source: "WOOCOMMERCE", externalId });
  if (reused) return customer.id;

  await recordAuditEvent({
    ...actorAuditFields(actor),
    action: "customer.created",
    entityType: "Customer",
    entityId: customer.id,
    newValue: { fullName: customer.fullName },
    metadata: { source: "WOOCOMMERCE" },
  });

  return customer.id;
}

async function createImportedOrder(
  wc: WcOrder,
  status: OrderStatus,
  customerId: string,
  actor: SyncActor,
  /** Set to the original WooCommerce status string only when
   * `forceNouvelleOnFirstImport` downgraded CONFIRMEE to NOUVELLE — recorded
   * on the audit event so staff can see why a "processing" order didn't
   * land as Confirmée. */
  downgradedFromWcStatus?: string,
  /** The store reports a failed PAYMENT (`failed`): imported NOUVELLE with paymentStatus ECHEC. */
  paymentFailed = false
): Promise<{ outcome: "imported"; orderId: string }> {
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
      paymentStatus: importedPaymentStatus({ paymentFailed, refundedStatus: wc.status === "refunded", paid: Boolean(wc.date_paid) }),
      paymentMethod: mapPaymentMethod(wc.payment_method),
      source: "WOOCOMMERCE",
      // Business channel (docs/adr/0038): every delivery order belongs to the
      // tenant's default ONLINE channel. Additive — never affects lifecycle.
      salesChannelId: await getDefaultOnlineChannelId(),
      externalId: String(wc.id),
      externalNumber: wc.number,
      placedAt: parseOrderPlacedAt(wc.date_created),
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
      ...storeTransitionDates(status, { deliveredAt: null, cancelledAt: null }, storeEventTimes(wc)),
      items: { create: items },
    },
  });
  const displayNumber = await claimTenantDisplayNumber(prisma, order.tenantId, "order");
  await prisma.order.update({ where: { id: order.id }, data: { displayNumber } });

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
    // Imported already cancelled AND fully refunded → payment REMBOURSE (decisions §3).
    await prisma.$transaction((tx) => applyCancelledFullRefund(tx, order.id));
  }

  await recordAuditEvent({
    ...actorAuditFields(actor),
    action: "order.created",
    entityType: "Order",
    entityId: order.id,
    // An imported payment failure is recorded with the store's own time: a
    // later « paid » report is ordered against it (applyStorePaymentEvent).
    newValue: { total: fields.total.toString(), customerId, ...(order.paymentStatus === "ECHEC" ? { paymentStatus: "ECHEC" } : {}) },
    metadata: {
      ...(order.paymentStatus === "ECHEC" ? { storeModifiedAt: storeEventTimes(wc).modified?.toISOString() ?? null } : {}),
      source: "WOOCOMMERCE",
      externalId: order.externalId,
      ...(downgradedFromWcStatus ? { forcedNouvelleFromWcStatus: downgradedFromWcStatus } : {}),
    },
  });

  // A webhook order.created is a real-time event — always alert. A manual
  // "Synchroniser les commandes" only alerts for an order actually placed
  // in the last couple of days, so a first-time history import doesn't
  // fan out hundreds of "nouvelle commande" notifications at once.
  if (actor.type === "INTEGRATION" || isRecentlyPlaced(wc.date_created)) {
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId }, select: { fullName: true } });
    await notifyNewOrder(
      {
        id: order.id,
        orderNumber: order.orderNumber,
        displayNumber,
        total: fields.total,
        currency: fields.currency,
        customerName: customer.fullName,
        source: "WOOCOMMERCE",
      },
      actorPerformedById(actor)
    );
  }

  // Read-only alert — never blocks the import and never touches stock.
  // Same recency guard as notifyNewOrder above: a first-time historical
  // sync of hundreds of old orders doesn't flood hundreds of alerts.
  if (actor.type === "INTEGRATION" || isRecentlyPlaced(wc.date_created)) {
    await checkAndNotifyInsufficientStockForOrder(
      { id: order.id, orderNumber: order.orderNumber, displayNumber, source: "WOOCOMMERCE", externalNumber: order.externalNumber },
      items.map((i) => ({ productId: i.productId, variationId: i.variationId, quantity: i.quantity }))
    );
  }

  return { outcome: "imported", orderId: order.id };
}

/** The store's own event times for this snapshot (UTC `*_gmt` fields). */
function storeEventTimes(wc: WcOrder): { modified: Date | null; delivered: Date | null; cancelled: Date | null } {
  const modified = storeEventTime(wc.date_modified_gmt, true);
  return { modified, delivered: storeEventTime(wc.date_completed_gmt, true) ?? modified, cancelled: modified };
}

async function updateExistingOrder(
  orderId: string,
  wc: WcOrder,
  status: OrderStatus,
  actor: SyncActor,
  options?: ImportOrderOptions,
  internal: {
    keepNewOrderAlert?: boolean;
    /** Leave the status as it is under the lock (unmappable store status, store payment failure). */
    keepCurrentStatus?: boolean;
    /** The store reports a failed PAYMENT: EN_ATTENTE → ECHEC, status untouched. */
    paymentFailed?: boolean;
  } = {}
): Promise<{ outcome: "updated" | "unchanged"; reason?: string }> {
  const existing = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const fields = mapOrderFields(wc, status);
  const label = `Commande WooCommerce #${wc.id}`;
  const eventTimes = storeEventTimes(wc);
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
    if (current.status !== status) {
      // Same rule as first import, now enforced on every later re-sync/
      // webhook update too (2026-09-13 fix): a store's own status must
      // never silently promote a still-unconfirmed order straight to
      // CONFIRMEE — only a human confirming inside ASODITECH does that.
      // Order.created landing the order as NOUVELLE (pending/on-hold) and
      // a LATER order.updated reporting "processing" was exactly the gap
      // that let an order become CONFIRMEE without ever being downgraded
      // by createImportedOrder's own forceNouvelleOnFirstImport, which
      // only ever looked at the FIRST snapshot. Every other transition
      // (→ LIVREE, → ANNULEE, → REMBOURSEE, → ECHEC, …) is untouched.
      const autoConfirmBlocked =
        current.status === "NOUVELLE" && status === "CONFIRMEE" && options?.forceNouvelleOnFirstImport !== false;
      // ASODITECH's own EXPEDIEE transition is the ONLY physical
      // -fulfillment event, for every order source (docs/adr/0036) —
      // symmetric guard with Shopify's identical one, even though
      // WooCommerce's own `mapOrderStatus` never maps to EXPEDIEE today
      // (no "shipped" WooCommerce order status is mapped) — this is a
      // deliberate belt-and-suspenders should that mapping ever change.
      const expedieeAutoAdvanceBlocked = status === "EXPEDIEE" && current.status !== "EXPEDIEE";
      // Same rule as « Rétablir la commande »: a shipped order never reopens.
      const reopenBlocked = status === "NOUVELLE" && current.status === "ANNULEE" && !isReopenable(current);
      // A stale snapshot never undoes a newer local confirmation / cancellation.
      const orderingRefusal = storeOrderingRefusal(label, status, current, eventTimes.modified);
      if (autoConfirmBlocked) {
        statusSkippedReason = `Commande WooCommerce #${wc.id} : reste "Nouvelle" — confirmation manuelle requise avant "Confirmée" (réglage "Toujours importer en Nouvelle").`;
      } else if (expedieeAutoAdvanceBlocked) {
        statusSkippedReason = `Commande WooCommerce #${wc.id} : le statut WooCommerce indique une expédition, mais seule l'action "Expédiée" dans ASODITECH peut faire progresser la commande et consommer le stock.`;
        workflowMismatch = wc.status;
      } else if (reopenBlocked) {
        statusSkippedReason = `Commande WooCommerce #${wc.id} : déjà expédiée — elle ne peut pas revenir à "Nouvelle" depuis "Annulée".`;
      } else if (orderingRefusal) {
        statusSkippedReason = orderingRefusal.reason;
        // Within the clock tolerance / order unknown: a person decides — alerted.
        if (orderingRefusal.kind === "review") workflowMismatch = wc.status;
      } else if (
        canTransitionOrderStatus(current.status, status) &&
        // Entering a reservation-holding status (NOUVELLE → CONFIRMEE, with
        // « Toujours importer en Nouvelle » off): the strict reservation is
        // taken first, in this transaction; a shortage keeps the order as it is.
        (!orderHoldsReservation(status) ||
          orderHoldsReservation(current.status) ||
          current.shippedAt !== null ||
          (await reserveForStoreConfirmation(tx, orderId, actorPerformedById(actor))) === "reserved")
      ) {
        const result = await tx.order.updateMany({
          where: { id: orderId, status: current.status },
          // The store reopening a cancelled order (ANNULEE → NOUVELLE) is a
          // reopen like any other (docs/adr/0049): the current confirmation
          // state (confirmedAt, commission attribution) is reset; attempts,
          // audit and ledger history stay.
          data:
            status === "NOUVELLE"
              ? REOPEN_ORDER_DATA
              : { status, ...packingResetFor(status), ...storeTransitionDates(status, current, eventTimes) },
        });
        // Under the row lock nothing else can have moved the order: a miss
        // here would leave a reservation without its status → roll back.
        if (result.count === 0) throw new Error(`${label} : statut modifié pendant la synchronisation.`);
        if (result.count > 0) {
          changedFields = true;
          // 2026-09-13 fix (production incident): keep the reservation
          // ledger honest no matter which side drove the transition. A
          // human cancelling inside ASODITECH already released the
          // reservation via cancelOrderAction/updateOrderStatusAction —
          // but a re-sync/webhook applying the SAME demotion (the store's
          // own status, e.g. WooCommerce still reporting "cancelled" from
          // before a manual re-confirmation this app never pushed back to
          // the store) used to leave the reservation stuck: order shown
          // ANNULEE, quantityReserved never released. Reopening +
          // re-confirming that order then double-reserved on top of the
          // orphaned one. Only ever releases (quantityReserved only,
          // never quantityOnHand) — never reserves or fulfills; this
          // function still never creates a reservation, exactly as
          // before.
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
        statusSkippedReason = `Commande WooCommerce #${wc.id} : transition ${current.status} → ${status} ignorée (déjà en cours de traitement localement).`;
        // A terminal/further-along external status than ASODITECH's own
        // current stage is a genuine workflow disagreement worth a
        // human's attention (docs/adr/0036) — not merely a sync-summary
        // footnote.
        if (status === "LIVREE" || status === "REMBOURSEE" || status === "ANNULEE") {
          workflowMismatch = wc.status;
        }
      }
    }

    const wantedPlacedAt = parseOrderPlacedAt(wc.date_created);
    const placedAtChanged = existing.placedAt.getTime() !== wantedPlacedAt.getTime();
    const totalsChanged =
      Number(existing.total) !== fields.total ||
      Number(existing.subtotal) !== fields.subtotal ||
      Number(existing.shippingCost) !== fields.shippingCost;
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

    const refunded = totalRefundedAmount(wc);
    if (refunded > 0) {
      const existingRefund = await tx.refund.findFirst({ where: { orderId, source: "WOOCOMMERCE" } });
      if (!existingRefund) {
        await tx.refund.create({
          data: { orderId, amount: refunded, reason: "Importé depuis WooCommerce", status: "COMPLETE", source: "WOOCOMMERCE" },
        });
        changedFields = true;
      } else if (toCents(existingRefund.amount) !== toCents(refunded)) {
        await tx.refund.update({ where: { id: existingRefund.id }, data: { amount: refunded } });
        changedFields = true;
      }
      // A refund recorded by hand next to the store's: possibly the same
      // money — never netted automatically, a person checks.
      if (changedFields) paymentReview = await orderMixedRefundReview(tx, orderId, label);
      if (wc.status === "refunded" && existing.paymentStatus !== "REMBOURSE") {
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
              metadata: { reason: "store_reported_payment_failed", source: "WOOCOMMERCE", storeModifiedAt: eventTimes.modified?.toISOString() ?? null },
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
      const payment = await applyStorePaymentEvent(orderId, Boolean(wc.date_paid), "WOOCOMMERCE", tx, {
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
      metadata: { source: "WOOCOMMERCE", via: actor.type === "INTEGRATION" ? "webhook_or_sync" : "sync" },
    });
  }

  // The store moved this order past "new" (e.g. paid / processing) — clear
  // the local "nouvelle commande" alert, same as a manual status change.
  if (previousStatus === "NOUVELLE" && status !== "NOUVELLE" && !internal.keepNewOrderAlert) {
    await resolveNotifications({ types: ["NOUVELLE_COMMANDE"], entityType: "Order", entityId: orderId });
  }
  if (workflowMismatch) {
    await notifyWorkflowMismatch({
      id: orderId,
      orderNumber: existing.orderNumber,
      displayNumber: existing.displayNumber,
      source: "WOOCOMMERCE",
      externalNumber: wc.number,
      localStatus: previousStatus,
      externalStatus: workflowMismatch,
    });
  }
  // A store-driven move into (or out of) LIVREE affects any
  // confirmation-agent commission — reconcile it. Idempotent, best-effort.
  if (previousStatus !== status && (status === "LIVREE" || previousStatus === "LIVREE")) {
    await reconcileOrderCommission(orderId);
  }

  return changedFields ? { outcome: "updated", reason: statusSkippedReason } : { outcome: "unchanged", reason: statusSkippedReason };
}

/**
 * Bulk order import — the manual "Synchroniser les commandes" action.
 * Imports new orders AND refreshes orders already held whose store state
 * differs (status, totals, refunds — ADR 0010/0030: a missed webhook is
 * recovered here), through the same update path and guards as a webhook
 * (`storeRefreshNeeded` leaves out transitions that would be refused every
 * time). It does at most a bounded amount of real work — new imports,
 * refreshes and placedAt corrections each have their own cap — before
 * stopping. Both caps are sized
 * for Vercel's Hobby tier (a hard ~10s wall clock): it is far better for
 * every run to finish and show real progress than for a larger batch to
 * occasionally run out of time and show nothing.
 *
 * Where it resumes: WooCommerce returns pages newest-first, so once the
 * newest orders are already held, a run that always restarted at page 1
 * would spend most of its time budget re-fetching and skipping those
 * same early pages before ever reaching new work. The page it stopped on
 * is persisted to `Integration.config.ordersResumePage`, so the next run
 * picks up exactly where this one left off — pure API-pagination
 * bookkeeping, unrelated to (and does not reintroduce) the wall-clock
 * date cursor removed earlier. A run that reaches the last page resets
 * the cursor to 1, so the next one re-checks from the newest orders.
 */
const MAX_IMPORTS_PER_RUN = 15;
const MAX_REFRESHES_PER_RUN = 15;
const MAX_PLACED_AT_FIXES_PER_RUN = 40;

export async function syncOrders(
  client: import("../client").WooCommerceClient,
  actor: SyncActor,
  integrationId: string
): Promise<SyncSummary> {
  const summary = emptySyncSummary();

  const integration = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
  const config = (integration.config as Record<string, unknown> | null) ?? {};
  const startPage =
    typeof config.ordersResumePage === "number" && config.ordersResumePage > 0
      ? Math.floor(config.ordersResumePage)
      : 1;
  // On by default — see ImportOrderOptions's doc comment. `false` is the
  // only value that opts out; unset/anything else keeps the safe default.
  const forceNouvelleOnFirstImport = config.forceNouvelleOnImport !== false;
  // « Paiement confirmé par la boutique »: a held failed payment the store now reports paid is refreshed only when it is on.
  const autoPaymentFromStore = (await prisma.businessSettings.findFirst({ select: { autoPaymentFromStore: true } }))?.autoPaymentFromStore ?? false;
  // « Importer l'historique » OFF: orders placed before the cutoff are left
  // out of the bulk import (pages are newest-first, so the first one older
  // than the cutoff ends the scan). Newer orders and webhooks: unchanged.
  const cutoff = historicalCutoff(config);

  let unreadable = 0;
  let importedThisRun = 0;
  let refreshedThisRun = 0;
  let fixedThisRun = 0;
  let capped = false;
  let reachedCutoff = false;
  let resumePage = 1;
  const unsupported = new Map<string, number>();

  for await (const { orders, unparsable, page, totalPages } of client.listAllOrders(startPage)) {
    unreadable += unparsable;
    resumePage = page >= totalPages ? 1 : page + 1;

    // One query per page instead of one per order — which of these do we
    // already hold, and does the held row still have a placeholder
    // placedAt (== createdAt, from the migration backfill) that a re-sync
    // should correct to the real WooCommerce order date?
    const held = new Map(
      (
        await prisma.order.findMany({
          where: { source: "WOOCOMMERCE", externalId: { in: orders.map((o) => String(o.id)) } },
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
            refunds: { where: { source: "WOOCOMMERCE" }, select: { amount: true } },
          },
        })
      ).map((r) => [r.externalId, r])
    );

    for (const wc of orders) {
      if (cutoff && parseOrderPlacedAt(wc.date_created) < cutoff) {
        reachedCutoff = true;
        resumePage = 1;
        break;
      }
      const existing = held.get(String(wc.id));
      if (existing) {
        const mapped = mapOrderStatus(wc.status);
        const paymentFailed = mapped.ok && mapped.paymentFailed === true;
        const needsRefresh = storePaymentRefreshNeeded(paymentFailed, existing.paymentStatus, { storeReportsPaid: Boolean(wc.date_paid), autoPaymentFromStore }) || storeRefreshNeeded({
          held: {
            status: existing.status,
            total: Number(existing.total),
            refunded: existing.refunds.reduce((sum, r) => sum + Number(r.amount), 0),
            confirmedAt: existing.confirmedAt,
            cancelledAt: existing.cancelledAt,
          },
          // A payment failure never changes a held order's status.
          mappedStatus: mapped.ok && !paymentFailed ? mapped.status : null,
          storeTotal: mapOrderFields(wc, existing.status).total,
          storeRefunded: totalRefundedAmount(wc),
          storeModifiedAt: storeEventTimes(wc).modified,
          forceNouvelleOnFirstImport,
          canTransition: canTransitionOrderStatus,
        });
        if (needsRefresh) {
          if (refreshedThisRun >= MAX_REFRESHES_PER_RUN) {
            capped = true;
            resumePage = page;
            break;
          }
          refreshedThisRun++;
          try {
            const { outcome, reason } = await importOrder(wc, actor, { forceNouvelleOnFirstImport });
            summary[outcome]++;
            if (reason) recordNote(summary, reason);
          } catch {
            recordNote(summary, `Commande WooCommerce #${wc.id} : échec de la mise à jour.`);
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
          resumePage = page;
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
        resumePage = page;
        break;
      }
      // A status no mapping exists for (typically a plugin's custom
      // status): counted and reported once per run, never guessed.
      if (isUnsupportedOrderStatus(wc.status)) {
        unsupported.set(wc.status, (unsupported.get(wc.status) ?? 0) + 1);
        summary.skipped++;
        continue;
      }
      try {
        const { outcome, reason } = await importOrder(wc, actor, { forceNouvelleOnFirstImport });
        summary[outcome]++;
        if (outcome === "imported") importedThisRun++;
        if (reason) recordNote(summary, reason);
      } catch {
        recordNote(summary, `Commande WooCommerce #${wc.id} : échec d'importation.`);
        summary.failed++;
      }
    }
    if (capped || reachedCutoff) break;
    // Saved after EVERY page (only this key, atomically): a run cut short by
    // the platform's time limit still resumes past the pages it finished.
    await patchIntegrationConfig(integrationId, { ordersResumePage: resumePage });
  }

  await patchIntegrationConfig(integrationId, { ordersResumePage: resumePage });

  summary.hasMore = capped;
  if (capped) {
    recordNote(
      summary,
      `Lot traité (max ${MAX_IMPORTS_PER_RUN} nouvelles, ${MAX_REFRESHES_PER_RUN} mises à jour, ${MAX_PLACED_AT_FIXES_PER_RUN} dates corrigées) — relancez « Synchroniser les commandes » pour continuer.`
    );
  }
  const unsupportedNote = unsupportedStatusNote("WooCommerce", unsupported);
  if (unsupportedNote) recordNote(summary, unsupportedNote);
  if (reachedCutoff) {
    recordNote(summary, "Historique non importé (réglage « Importer l'historique des commandes » désactivé) : les commandes antérieures à la date choisie sont ignorées.");
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
