import "server-only";

import type { OrderStatus } from "@prisma/client";
import type { PrismaTransactionClient } from "@/lib/prisma";
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
export async function orderReservedUnits(tx: PrismaTransactionClient, orderId: string): Promise<number> {
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
 * Event ordering for the two transitions where a STALE store snapshot would
 * undo a newer local decision (snapshots carry the store's own modification
 * time; ASODITECH records `confirmedAt` / `cancelledAt`):
 * - → ANNULEE of an order a person confirmed in ASODITECH: applied only when
 *   the store's snapshot is newer than that confirmation;
 * - ANNULEE → NOUVELLE (store reopen): applied only when newer than the
 *   cancellation.
 * When either time is unknown the order cannot be established → refused with
 * a reason (the order stays as it is; staff decide). Returns the refusal, or
 * null when the transition may go through.
 */
export function storeOrderingRefusal(
  label: string,
  target: OrderStatus,
  current: { status: OrderStatus; confirmedAt: Date | null; cancelledAt: Date | null },
  storeModifiedAt: Date | null
): string | null {
  if (target === "ANNULEE" && current.confirmedAt) {
    if (!storeModifiedAt) {
      return `${label} : annulation de la boutique non appliquée — sa date de modification est inconnue et la commande a été confirmée dans ASODITECH le ${current.confirmedAt.toISOString()}. À vérifier.`;
    }
    if (storeModifiedAt.getTime() <= current.confirmedAt.getTime()) {
      return `${label} : annulation de la boutique antérieure à la confirmation dans ASODITECH — non appliquée.`;
    }
  }
  if (target === "NOUVELLE" && current.status === "ANNULEE") {
    if (!storeModifiedAt || !current.cancelledAt) {
      return `${label} : réouverture par la boutique non appliquée — l'ordre des événements ne peut pas être établi. Utilisez « Rétablir » si nécessaire.`;
    }
    if (storeModifiedAt.getTime() <= current.cancelledAt.getTime()) {
      return `${label} : état de la boutique antérieur à l'annulation — la commande n'est pas rouverte.`;
    }
  }
  return null;
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
