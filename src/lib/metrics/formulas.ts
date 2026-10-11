import type { OrderStatus, ShipmentStatus } from "@prisma/client";

/**
 * The ONE formula behind each metric label (S6 — docs/analytics/
 * metric-definitions.md, « Définitions unifiées »). Pure and client-safe:
 * every screen that shows the label computes it through these, and the
 * in-app explanations (src/lib/metrics/glossary.ts) compute their worked
 * examples through them too, so an example can never contradict the code.
 */

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Order statuses whose total is never revenue (cancelled, failed, returned, refunded). */
export const NON_REVENUE_ORDER_STATUSES: readonly OrderStatus[] = ["ANNULEE", "ECHEC", "RETOUR", "REMBOURSEE"];

/**
 * « Chiffre d'affaires » — net: Σ order totals (delivery fee charged to the
 * customer included, discounts deducted) of the period's revenue orders,
 * minus COMPLETE refunds recorded on those orders.
 */
export function netRevenue(grossOrderTotals: number, completedRefunds: number): number {
  return round2(grossOrderTotals - completedRefunds);
}

/** « Panier moyen » — gross order total ÷ revenue orders (refunds are later events, not a smaller basket). */
export function averageBasket(grossOrderTotals: number, revenueOrders: number): number | null {
  return revenueOrders > 0 ? round2(grossOrderTotals / revenueOrders) : null;
}

export type DeliveryOutcome = "delivered" | "failed" | "returned";

/**
 * An order's FINAL delivery outcome — its current shipment's (the newest
 * real parcel), or, for an order handled without any shipment record, its
 * own status. A return recorded on the order wins over the parcel's
 * « Livré » (goods delivered, then sent back). `null` = no outcome yet
 * (in transit, waiting) or none (cancelled).
 */
export function orderDeliveryOutcome(orderStatus: OrderStatus, currentShipmentStatus: ShipmentStatus | null): DeliveryOutcome | null {
  if (orderStatus === "RETOUR" || orderStatus === "REMBOURSEE") return "returned";
  if (currentShipmentStatus) {
    if (currentShipmentStatus === "LIVRE") return "delivered";
    if (currentShipmentStatus === "RETOURNE") return "returned";
    if (currentShipmentStatus === "ECHEC") return "failed";
    return null;
  }
  if (orderStatus === "LIVREE") return "delivered";
  if (orderStatus === "ECHEC") return "failed";
  return null;
}

export interface OutcomeCounts {
  delivered: number;
  failed: number;
  returned: number;
}

export function countOutcomes(outcomes: (DeliveryOutcome | null)[]): OutcomeCounts {
  const c: OutcomeCounts = { delivered: 0, failed: 0, returned: 0 };
  for (const o of outcomes) if (o) c[o] += 1;
  return c;
}

/**
 * « Taux de livraison réussie » — delivered ÷ (delivered + failed +
 * returned), one outcome per order. Parcels still on their way and
 * cancelled ones have no outcome and stay out. `null` when nothing has an
 * outcome (never a fake 0 %). A ratio 0–1.
 */
export function deliveryOutcomeRate(c: OutcomeCounts): number | null {
  const outcomes = c.delivered + c.failed + c.returned;
  return outcomes > 0 ? c.delivered / outcomes : null;
}

/**
 * « Taux de confirmation » — orders whose confirmation stands (confirmedAt
 * set) ÷ orders that went through confirmation (at least one confirmation
 * attempt recorded, or confirmed on import). An order that later failed or
 * was returned still WAS confirmed; one that reached such a status without
 * ever being confirmed is not. Orders nobody has called yet stay out (they
 * are « À confirmer »). A percentage, one decimal.
 */
export function confirmationRatePct(confirmed: number, wentThroughConfirmation: number): number | null {
  return wentThroughConfirmation > 0 ? round1((confirmed / wentThroughConfirmation) * 100) : null;
}

/** A ratio 0–1 as a percentage with one decimal (null stays null). */
export function asPct(ratio: number | null): number | null {
  return ratio === null ? null : round1(ratio * 100);
}
