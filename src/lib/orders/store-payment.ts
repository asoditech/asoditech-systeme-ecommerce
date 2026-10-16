import { prisma, type PrismaTransactionClient } from "@/lib/prisma";
import { recordAuditEvent } from "@/lib/audit";
import { placeStoreEvent, type StoreOrderingRefusal } from "@/lib/integrations/shared/order-sync-rules";

/**
 * « Paiement confirmé par la boutique » (BusinessSettings.autoPaymentFromStore,
 * default OFF). Payment and delivery stay separate concepts:
 *  - the ONLY automatic source is the store itself reporting the order paid
 *    (WooCommerce `date_paid`, Shopify `displayFinancialStatus = PAID`) — the
 *    store is where the customer actually paid (card, transfer…);
 *  - a carrier « Livré » never marks an order paid HERE: that is the
 *    separate, company-level rule « payée à la livraison »
 *    (src/lib/orders/delivered-payment.ts, default OFF);
 *  - a WooCommerce CASH-ON-DELIVERY order's `date_paid` is NOT a payment:
 *    WooCommerce stamps it when the merchant marks the order « completed »
 *    (or a plugin / zero total / REST `set_paid`), which proves no cash was
 *    collected (docs/research/woocommerce-date-paid-cod-2026-10-16.md) —
 *    so it is ignored, at import and later, and COD payment comes from
 *    delivery (when the company opted in) or a person;
 *  - EN_ATTENTE → PAYE; and ECHEC → PAYE when the store's paid report is
 *    clearly NEWER than the recorded payment failure (owner decision
 *    2026-10-14 bis — see `applyStorePaymentEvent`). PAYE /
 *    PARTIELLEMENT_PAYE / REMBOURSE are never overwritten, and the store
 *    reporting "unpaid" never reverts anything;
 *  - a payment change alone NEVER changes the order's status: no
 *    confirmation, no stock reservation, no shipment.
 * The conditional updateMany makes it idempotent (repeated webhooks / syncs:
 * one change, one audit event).
 */

/** WooCommerce's « paid » signal, excluding cash on delivery (see above). */
export function wooReportsPaid(wc: { date_paid?: string | null; payment_method?: string | null }): boolean {
  if (!wc.date_paid) return false;
  return (wc.payment_method ?? "").trim().toLowerCase() !== "cod";
}

export async function applyStorePaymentConfirmation(
  orderId: string,
  storeReportsPaid: boolean,
  source: "WOOCOMMERCE" | "SHOPIFY",
  db: PrismaTransactionClient | typeof prisma = prisma,
  event: StorePaymentEvent = {}
): Promise<boolean> {
  return (await applyStorePaymentEvent(orderId, storeReportsPaid, source, db, event)).changed;
}

export interface StorePaymentEvent {
  /** The store snapshot's own modification time (null / absent = unknown). */
  storeModifiedAt?: Date | null;
  /** The same snapshot reports a payment failure — never a success then. */
  paymentFailed?: boolean;
  /** « Commande WooCommerce #12 » — for refusal reasons. */
  label?: string;
}

export interface StorePaymentOutcome {
  changed: boolean;
  /** Set when a failed payment was NOT recovered: "stale" (older report) or "review" (a person decides). */
  refusal: StoreOrderingRefusal | null;
}

/**
 * Time of the payment failure the order currently carries, from the audit
 * trail (no schema column records it): the latest Order audit event whose
 * new value set `paymentStatus` to ECHEC — a store failure carries the
 * store's own modification time (`metadata.storeModifiedAt`, store clock),
 * a person's change its own `createdAt` (ASODITECH clock). Null when there
 * is no such event (a legacy ECHEC) or the store event has no usable time.
 */
async function lastPaymentFailureAt(db: PrismaTransactionClient | typeof prisma, orderId: string): Promise<Date | null> {
  const event = await db.auditEvent.findFirst({
    where: { entityType: "Order", entityId: orderId, newValue: { path: ["paymentStatus"], equals: "ECHEC" } },
    orderBy: { createdAt: "desc" },
    select: { actorType: true, createdAt: true, metadata: true },
  });
  if (!event) return null;
  const raw = (event.metadata as { storeModifiedAt?: unknown } | null)?.storeModifiedAt;
  if (typeof raw === "string") {
    const at = new Date(raw);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  return event.actorType === "USER" ? event.createdAt : null;
}

/**
 * The store reports this order paid. EN_ATTENTE → PAYE as before. ECHEC →
 * PAYE (owner decision 2026-10-14 bis) only when ALL hold:
 *  - « Paiement confirmé par la boutique » is on (same opt-in as EN_ATTENTE);
 *  - the same snapshot does not also report a failure;
 *  - the order is not cancelled (a payment on a cancelled order → a person);
 *  - the paid report is clearly NEWER than the recorded failure, with the
 *    shared 2-minute tolerance (`placeStoreEvent`): older → refused as
 *    stale; within ±2 min, or either time unknown → left for review.
 * Refund protection is the caller's: it is never called while the store
 * reports a refund. Run inside the caller's order-row-locked transaction.
 */
export async function applyStorePaymentEvent(
  orderId: string,
  storeReportsPaid: boolean,
  source: "WOOCOMMERCE" | "SHOPIFY",
  db: PrismaTransactionClient | typeof prisma = prisma,
  event: StorePaymentEvent = {}
): Promise<StorePaymentOutcome> {
  const none: StorePaymentOutcome = { changed: false, refusal: null };
  if (!storeReportsPaid || event.paymentFailed) return none;
  const settings = await db.businessSettings.findFirst({ select: { autoPaymentFromStore: true } });
  if (!settings?.autoPaymentFromStore) return none;

  const order = await db.order.findUnique({ where: { id: orderId }, select: { paymentStatus: true, status: true } });
  if (!order) return none;
  const label = event.label ?? "Commande";

  if (order.paymentStatus === "EN_ATTENTE") {
    const changed = await db.order.updateMany({ where: { id: orderId, paymentStatus: "EN_ATTENTE" }, data: { paymentStatus: "PAYE" } });
    if (changed.count === 0) return none;
    await recordAuditEvent(
      {
        actorType: "INTEGRATION",
        action: "order.updated",
        entityType: "Order",
        entityId: orderId,
        previousValue: { paymentStatus: "EN_ATTENTE" },
        newValue: { paymentStatus: "PAYE" },
        metadata: { reason: "store_reported_paid", source },
      },
      db
    );
    return { changed: true, refusal: null };
  }

  if (order.paymentStatus !== "ECHEC") return none;

  if (order.status === "ANNULEE") {
    return {
      changed: false,
      refusal: { kind: "review", reason: `${label} : la boutique indique un paiement reçu pour une commande annulée — paiement non modifié, à vérifier (remboursement ?).` },
    };
  }
  const failedAt = await lastPaymentFailureAt(db, orderId);
  const placement = placeStoreEvent(event.storeModifiedAt ?? null, failedAt);
  if (placement === "stale") {
    return { changed: false, refusal: { kind: "stale", reason: `${label} : paiement reçu antérieur à l'échec de paiement enregistré — non appliqué.` } };
  }
  if (placement !== "newer") {
    return {
      changed: false,
      refusal: {
        kind: "review",
        reason:
          placement === "unknown"
            ? `${label} : la boutique indique un paiement reçu, mais l'ordre avec l'échec de paiement enregistré ne peut pas être établi — paiement non modifié, à vérifier.`
            : `${label} : paiement reçu à moins de 2 minutes de l'échec de paiement enregistré — ordre des événements incertain, paiement non modifié, à vérifier.`,
      },
    };
  }
  const changed = await db.order.updateMany({
    where: { id: orderId, paymentStatus: "ECHEC", status: { not: "ANNULEE" } },
    data: { paymentStatus: "PAYE" },
  });
  if (changed.count === 0) return none;
  await recordAuditEvent(
    {
      actorType: "INTEGRATION",
      action: "order.updated",
      entityType: "Order",
      entityId: orderId,
      previousValue: { paymentStatus: "ECHEC" },
      newValue: { paymentStatus: "PAYE" },
      metadata: { reason: "store_reported_paid_after_failure", source, storeModifiedAt: event.storeModifiedAt?.toISOString() ?? null },
    },
    db
  );
  return { changed: true, refusal: null };
}
