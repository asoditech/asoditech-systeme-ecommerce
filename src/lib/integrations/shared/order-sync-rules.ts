import "server-only";

import type { OrderStatus } from "@prisma/client";
import type { PrismaTransactionClient, prisma } from "@/lib/prisma";
import { orderLineStockStates } from "@/lib/inventory";
import { CONFIRMATION_STOCK_ITEM_SELECT, reserveForConfirmation, withTracking } from "@/lib/stock-validation";

/**
 * Store → ASODITECH order rules shared by the WooCommerce and Shopify order
 * syncs (bulk « Synchroniser les commandes » and webhooks alike), so neither
 * provider can drift from the stock invariant of docs/adr/0030 / 0036:
 * an order holds a reservation ⟺ CONFIRMEE / EN_PREPARATION and not shipped.
 */

/**
 * Units this order still holds in reservation, from its OWN stock ledger:
 * RESERVATION − LIBERATION − VENTE movements carrying its `orderId`. Used so a
 * store-driven demotion only ever releases what the order actually reserved —
 * never twice, never a reservation it never took (an order imported straight
 * into CONFIRMEE before this rule, a retried order after shipping, …).
 */
export async function orderReservedUnits(tx: PrismaTransactionClient | typeof prisma, orderId: string): Promise<number> {
  const rows = await tx.inventoryMovement.groupBy({
    by: ["type"],
    where: { orderId, type: { in: ["RESERVATION", "LIBERATION", "VENTE"] } },
    _sum: { quantity: true },
  });
  const sum = (type: string) => rows.find((r) => r.type === type)?._sum.quantity ?? 0;
  return sum("RESERVATION") - sum("LIBERATION") - sum("VENTE");
}

/**
 * The store moves an order into CONFIRMEE (only with « Toujours importer en
 * Nouvelle » switched off): the SAME reservation a human confirmation takes
 * (ADR 0036 « → CONFIRMEE: reserve », every source alike) — strictly within
 * physical stock, no override. Read-only pre-check first: a shortage returns
 * "short" with nothing reserved (the caller keeps the order NOUVELLE), so an
 * order is never half-reserved. A shortage appearing between the check and
 * the write throws inside the caller's transaction → full rollback.
 */
export async function reserveForStoreConfirmation(
  tx: PrismaTransactionClient,
  orderId: string,
  performedById: string | null
): Promise<"reserved" | "short"> {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { fulfillmentWarehouseId: true, items: { select: CONFIRMATION_STOCK_ITEM_SELECT } },
  });
  const states = await orderLineStockStates(tx, withTracking(order.items), order.fulfillmentWarehouseId);
  if (states.some((s) => s.kind === "tracked" && s.short)) return "short";
  await reserveForConfirmation(tx, {
    orderId,
    fulfillmentWarehouseId: order.fulfillmentWarehouseId,
    lines: order.items,
    confirmerUserId: performedById,
    override: null,
  });
  return "reserved";
}

/**
 * A provider timestamp → Date, or null when absent / unparseable. WooCommerce
 * `*_gmt` fields carry no zone suffix: they are UTC by definition.
 */
export function storeEventTime(raw: string | null | undefined, assumeUtc = false): Date | null {
  if (!raw) return null;
  const iso = assumeUtc && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? `${raw}Z` : raw;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Clock tolerance between a store and ASODITECH (owner decision 2026-10-14,
 * docs/decisions/order-sync-open-decisions.md §4): 2 minutes.
 */
export const STORE_CLOCK_TOLERANCE_MS = 2 * 60 * 1000;

/**
 * Where a store event sits against a local decision time, both compared as
 * UTC epoch milliseconds (`Date.getTime()`, timezone-independent):
 * - "newer": store time > local + 2 min (strictly);
 * - "ambiguous": |store − local| ≤ 2 min — BOTH boundaries inclusive, so
 *   exactly ±2 min is still ambiguous;
 * - "stale": store time < local − 2 min (strictly);
 * - "unknown": either time missing or invalid (an Invalid Date).
 * Pure; never changes either timestamp.
 */
export type StoreEventPlacement = "newer" | "ambiguous" | "stale" | "unknown";

export function placeStoreEvent(storeAt: Date | null, localAt: Date | null): StoreEventPlacement {
  const store = storeAt?.getTime();
  const local = localAt?.getTime();
  if (store === undefined || local === undefined || Number.isNaN(store) || Number.isNaN(local)) return "unknown";
  const diff = store - local;
  if (diff > STORE_CLOCK_TOLERANCE_MS) return "newer";
  if (diff < -STORE_CLOCK_TOLERANCE_MS) return "stale";
  return "ambiguous";
}

/**
 * A refused store transition: "stale" = the store's state predates the local
 * decision (rejected); "review" = the order of events cannot be established
 * (inside the clock tolerance, or a time is unknown) — left for a person,
 * who is alerted (workflow mismatch).
 */
export interface StoreOrderingRefusal {
  kind: "stale" | "review";
  reason: string;
}

/**
 * Event ordering for the two transitions where a STALE store snapshot would
 * undo a newer local decision (snapshots carry the store's own modification
 * time; ASODITECH records `confirmedAt` / `cancelledAt`):
 * - → ANNULEE of an order a person confirmed in ASODITECH;
 * - ANNULEE → NOUVELLE (store reopen) after a cancellation.
 * Applied only when the store event is clearly newer than the local decision
 * (`placeStoreEvent` = "newer"); clearly older → refused as stale; within the
 * 2-minute tolerance or unknown → refused for manual review. Returns the
 * refusal, or null when the transition may go through. Shared by both
 * providers (webhooks and bulk sync).
 */
export function storeOrderingRefusal(
  label: string,
  target: OrderStatus,
  current: { status: OrderStatus; confirmedAt: Date | null; cancelledAt: Date | null },
  storeModifiedAt: Date | null
): StoreOrderingRefusal | null {
  if (target === "ANNULEE" && current.confirmedAt) {
    const placement = placeStoreEvent(storeModifiedAt, current.confirmedAt);
    if (placement === "unknown") {
      return {
        kind: "review",
        reason: `${label} : annulation de la boutique non appliquée — sa date de modification est inconnue et la commande a été confirmée dans ASODITECH le ${current.confirmedAt.toISOString()}. À vérifier.`,
      };
    }
    if (placement === "stale") {
      return { kind: "stale", reason: `${label} : annulation de la boutique antérieure à la confirmation dans ASODITECH — non appliquée.` };
    }
    if (placement === "ambiguous") {
      return {
        kind: "review",
        reason: `${label} : annulation de la boutique à moins de 2 minutes de la confirmation dans ASODITECH (${current.confirmedAt.toISOString()}) — ordre des événements incertain, non appliquée. À vérifier.`,
      };
    }
  }
  if (target === "NOUVELLE" && current.status === "ANNULEE") {
    const placement = placeStoreEvent(storeModifiedAt, current.cancelledAt);
    if (placement === "unknown") {
      return {
        kind: "review",
        reason: `${label} : réouverture par la boutique non appliquée — l'ordre des événements ne peut pas être établi. Utilisez « Rétablir » si nécessaire.`,
      };
    }
    if (placement === "stale") {
      return { kind: "stale", reason: `${label} : état de la boutique antérieur à l'annulation — la commande n'est pas rouverte.` };
    }
    if (placement === "ambiguous") {
      return {
        kind: "review",
        reason: `${label} : réouverture par la boutique à moins de 2 minutes de l'annulation dans ASODITECH — ordre des événements incertain, non appliquée. Utilisez « Rétablir » si nécessaire.`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Payment failure at import (owner decision 2026-10-14, decisions §1, option A)
// ---------------------------------------------------------------------------

/**
 * Payment status of a NEW imported order. A store payment failure
 * (WooCommerce `failed`, Shopify `EXPIRED`) is a PAYMENT fact: the order
 * itself is imported NOUVELLE (actionable — call the customer, COD
 * fallback) and only `paymentStatus` says ECHEC. Never a failed delivery.
 */
export function importedPaymentStatus(params: {
  paymentFailed: boolean;
  refundedStatus: boolean;
  paid: boolean;
}): "ECHEC" | "REMBOURSE" | "PAYE" | "EN_ATTENTE" {
  if (params.refundedStatus) return "REMBOURSE";
  if (params.paymentFailed) return "ECHEC";
  return params.paid ? "PAYE" : "EN_ATTENTE";
}

/**
 * A store payment failure reported for an order ASODITECH already holds:
 * the order's STATUS is never changed by it (a confirmed / shipped order is
 * not demoted, no reservation released); only a payment still EN_ATTENTE
 * becomes ECHEC — PAYE, PARTIELLEMENT_PAYE, REMBOURSE (or ECHEC already)
 * are never overwritten. Returns the new payment status, or null.
 */
export function heldOrderPaymentFailure(currentPaymentStatus: string): "ECHEC" | null {
  return currentPaymentStatus === "EN_ATTENTE" ? "ECHEC" : null;
}

// ---------------------------------------------------------------------------
// Cancelled + fully refunded (owner decision 2026-10-14, decisions §3, option B)
// ---------------------------------------------------------------------------

/** Amount → integer cents (Decimal(12,2) money; the string form avoids float drift). */
export function toCents(value: number | string | { toString(): string }): number {
  return Math.round(Number(value.toString()) * 100);
}

/**
 * Whether confirmed refunds cover the order's refundable total. Compared in
 * integer cents (both sides are Decimal(12,2) in the order's own currency —
 * refunds carry no other currency). A zero / negative total is never
 * « covered » (nothing was paid to refund).
 */
export function refundsCoverOrderTotal(orderTotal: number | string | { toString(): string }, refundAmounts: Array<number | string | { toString(): string }>): boolean {
  const total = toCents(orderTotal);
  if (total <= 0) return false;
  return refundAmounts.reduce<number>((sum, a) => sum + toCents(a), 0) >= total;
}

/**
 * Order status stays ANNULEE (what happened to the order); the INDEPENDENT
 * payment status becomes REMBOURSE only when COMPLETE refund rows (any
 * source: store-imported or recorded in ASODITECH) cover the order total.
 * A cancellation alone never implies a refund; a partial refund stays
 * partial; a payment already REMBOURSE is left as is. Run inside the
 * caller's order-row-locked transaction, after the refund rows are written,
 * so a duplicate refund delivery sees the single refund row and changes
 * nothing. Returns true when it changed the payment status.
 */
export async function applyCancelledFullRefund(tx: PrismaTransactionClient, orderId: string): Promise<boolean> {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { status: true, paymentStatus: true, total: true, refunds: { where: { status: "COMPLETE" }, select: { amount: true, source: true } } },
  });
  if (order.status !== "ANNULEE" || order.paymentStatus === "REMBOURSE") return false;
  // Store refunds and refunds recorded by hand may be the SAME money
  // (owner decision 2026-10-14 bis): only an unambiguous coverage counts.
  if (refundCoverage(order.total, order.refunds) !== "covered") return false;
  const result = await tx.order.updateMany({ where: { id: orderId, status: "ANNULEE", paymentStatus: order.paymentStatus }, data: { paymentStatus: "REMBOURSE" } });
  return result.count > 0;
}

// ---------------------------------------------------------------------------
// Refund identity: store refunds vs refunds recorded by hand
// (owner decision 2026-10-14 bis, docs/decisions/order-sync-open-decisions.md)
// ---------------------------------------------------------------------------

/**
 * Provider refund sources. A store's refunds are held as ONE row per order
 * and provider (`source` = WOOCOMMERCE / SHOPIFY, reason « Importé depuis …»)
 * whose amount is the store's own cumulative refunded total, rewritten (never
 * added to) on every delivery — so a duplicate or replayed delivery cannot
 * count a provider refund twice. A refund recorded by hand in ASODITECH is a
 * separate row with `source` = INTERNE: never sent to the store, never
 * assumed executed there.
 */
export const PROVIDER_REFUND_SOURCES = ["WOOCOMMERCE", "SHOPIFY"] as const;

export function isProviderRefund(source: string): boolean {
  return (PROVIDER_REFUND_SOURCES as readonly string[]).includes(source);
}

export type RefundCoverage = "covered" | "partial" | "ambiguous";

/**
 * Whether the given refunds (COMPLETE ones — filtered by the caller) cover
 * the order total, in integer cents, WITHOUT ever adding a store refund to a
 * refund recorded by hand that may be the same money:
 * - one kind only (all store, or all manual) → its sum decides;
 * - both kinds → "covered" only when the store refunds ALONE, or the manual
 *   refunds ALONE, cover the total; otherwise the combination cannot be
 *   trusted (same money twice, or two halves?) → "ambiguous" (a person
 *   decides — nothing is changed automatically).
 * Pure.
 */
export function refundCoverage(
  orderTotal: number | string | { toString(): string },
  refunds: Array<{ amount: number | string | { toString(): string }; source: string }>
): RefundCoverage {
  const provider = refunds.filter((r) => isProviderRefund(r.source)).map((r) => r.amount);
  const manual = refunds.filter((r) => !isProviderRefund(r.source)).map((r) => r.amount);
  if (provider.length === 0 || manual.length === 0) {
    return refundsCoverOrderTotal(orderTotal, [...provider, ...manual]) ? "covered" : "partial";
  }
  if (refundsCoverOrderTotal(orderTotal, provider) || refundsCoverOrderTotal(orderTotal, manual)) return "covered";
  return refundsCoverOrderTotal(orderTotal, [...provider, ...manual]) ? "ambiguous" : "partial";
}

/**
 * Review reason when an order holds BOTH a store refund and a refund recorded
 * by hand (not rejected): ASODITECH has no external refund identifier on the
 * manual row (no schema column), so it cannot tell whether they are the same
 * money — a person must check (and reject the manual row if it duplicates the
 * store's). Null when only one kind exists. Pure.
 */
export function mixedRefundReviewReason(
  label: string,
  refunds: Array<{ amount: number | string | { toString(): string }; source: string }>
): string | null {
  const providerCents = refunds.filter((r) => isProviderRefund(r.source)).reduce((sum, r) => sum + toCents(r.amount), 0);
  const manualCents = refunds.filter((r) => !isProviderRefund(r.source)).reduce((sum, r) => sum + toCents(r.amount), 0);
  if (providerCents <= 0 || manualCents <= 0) return null;
  const fmt = (cents: number) => (cents / 100).toFixed(2);
  return (
    `${label} : remboursement de la boutique (${fmt(providerCents)}) ET remboursement saisi dans ASODITECH (${fmt(manualCents)}) — ` +
    `impossible de savoir s'il s'agit du même argent. Vérifiez et rejetez le remboursement manuel s'il fait doublon.`
  );
}

/** Reads the order's non-rejected refunds and returns the mixed-refund review reason, if any. */
export async function orderMixedRefundReview(tx: PrismaTransactionClient, orderId: string, label: string): Promise<string | null> {
  const refunds = await tx.refund.findMany({ where: { orderId, status: { not: "REJETE" } }, select: { amount: true, source: true } });
  return mixedRefundReviewReason(label, refunds);
}

// ---------------------------------------------------------------------------
// Shopify FULFILLED (owner decision 2026-10-14, decisions §2, option B)
// ---------------------------------------------------------------------------

/**
 * Statuses past the shipment step: a store « shipped / fulfilled » report
 * for such an order is simply behind ASODITECH (delivered by the carrier or
 * staff, returned, refunded) — no workflow mismatch, nothing changes.
 */
const PAST_SHIPMENT_STATUSES: OrderStatus[] = ["EXPEDIEE", "LIVREE", "RETOUR", "REMBOURSEE"];

export function storeShipmentReportIsBehind(current: OrderStatus): boolean {
  return PAST_SHIPMENT_STATUSES.includes(current);
}

/**
 * Dates a store-driven transition records, like the manual one does
 * (`src/actions/orders.ts`): `deliveredAt` on LIVREE, `cancelledAt` on
 * ANNULEE — the provider's own event time when it has one, else this
 * processing time. Never overwrites a date already set (a replayed or stale
 * event cannot move it).
 */
export function storeTransitionDates(
  target: OrderStatus,
  current: { deliveredAt: Date | null; cancelledAt: Date | null },
  eventAt: { delivered?: Date | null; cancelled?: Date | null },
  now: Date = new Date()
): { deliveredAt?: Date; cancelledAt?: Date } {
  if (target === "LIVREE" && !current.deliveredAt) return { deliveredAt: eventAt.delivered ?? now };
  if (target === "ANNULEE" && !current.cancelledAt) return { cancelledAt: eventAt.cancelled ?? now };
  return {};
}

/**
 * Bulk « Synchroniser les commandes » (ADR 0010/0030: a later manual sync
 * refreshes status, totals and refunds of orders already held): whether this
 * held order needs the update path at all. A status difference counts only
 * when the update path could apply it — a transition it always refuses
 * (blocked auto-confirmation, a store EXPEDIEE, a move the state machine
 * forbids, an ordering refusal) is left out, so such orders never use up a
 * run's refresh budget again and again. Pure.
 */
export function storeRefreshNeeded(params: {
  held: { status: OrderStatus; total: number; refunded: number; confirmedAt: Date | null; cancelledAt: Date | null };
  mappedStatus: OrderStatus | null;
  storeTotal: number;
  storeRefunded: number;
  storeModifiedAt: Date | null;
  forceNouvelleOnFirstImport: boolean;
  canTransition: (from: OrderStatus, to: OrderStatus) => boolean;
}): boolean {
  const { held, mappedStatus } = params;
  if (held.total !== params.storeTotal || held.refunded !== params.storeRefunded) return true;
  if (!mappedStatus || mappedStatus === held.status) return false;
  if (params.forceNouvelleOnFirstImport && held.status === "NOUVELLE" && mappedStatus === "CONFIRMEE") return false;
  if (mappedStatus === "EXPEDIEE") return false;
  if (!params.canTransition(held.status, mappedStatus)) return false;
  return storeOrderingRefusal("", mappedStatus, held, params.storeModifiedAt) === null;
}

/**
 * Bulk refresh, payment side: a held order whose payment the store now
 * reports failed while ours is still EN_ATTENTE (the status itself is never
 * changed by a payment failure — see `heldOrderPaymentFailure`).
 */
export function storePaymentRefreshNeeded(
  paymentFailed: boolean,
  heldPaymentStatus: string,
  recovery: { storeReportsPaid: boolean; autoPaymentFromStore: boolean } = { storeReportsPaid: false, autoPaymentFromStore: false }
): boolean {
  if (paymentFailed) return heldOrderPaymentFailure(heldPaymentStatus) !== null;
  // A failed payment the store now reports paid (decision 2026-10-14 bis):
  // only when « Paiement confirmé par la boutique » is on.
  return recovery.autoPaymentFromStore && recovery.storeReportsPaid && heldPaymentStatus === "ECHEC";
}
