import type { OrderStatus, RecordSource, ShipmentStatus } from "@prisma/client";
import { orderHoldsReservation } from "@/lib/validation/order";

/**
 * Controlled purge of a TEST order — pure eligibility + preview (no I/O).
 * The action (src/actions/order-purge.ts) re-reads the order under a row
 * lock and calls this again before deleting anything.
 *
 * Purgeable = an order created in ASODITECH that never left the warehouse:
 *   - source INTERNE (a WooCommerce/Shopify order would be re-imported by
 *     the next sync, matched on source + externalId);
 *   - status NOUVELLE, CONFIRMEE, EN_PREPARATION or ANNULEE, and never
 *     shipped (`shippedAt` null — EXPEDIEE is the only stock deduction);
 *   - no shipment except failed API attempts (status ECHEC, no externalId):
 *     a real carrier parcel or any manual shipment blocks the purge;
 *   - no refund, no physical return, no commission entry.
 * A reservation (CONFIRMEE / EN_PREPARATION) is released through the
 * existing releaseStockForOrder — never by editing stock quantities.
 * Inventory movements and audit history are never deleted.
 */

export const PURGEABLE_STATUSES: readonly OrderStatus[] = ["NOUVELLE", "CONFIRMEE", "EN_PREPARATION", "ANNULEE"];

export interface PurgeOrderSnapshot {
  status: OrderStatus;
  source: RecordSource;
  shippedAt: Date | null;
  items: { productId: string | null; variationId: string | null; nameSnapshot: string; skuSnapshot: string; quantity: number }[];
  shipments: { id: string; status: ShipmentStatus; externalId: string | null; trackingNumber: string | null }[];
  refundCount: number;
  returnCount: number;
  commissionEntryCount: number;
}

export interface PurgePreview {
  /** CONFIRMEE / EN_PREPARATION: the reservation released before deletion. */
  releaseReservation: boolean;
  /** Units released per line (empty when nothing is reserved). */
  releasedLines: { name: string; sku: string; quantity: number }[];
  /** Failed creation attempts (ECHEC, no carrier parcel) removed with the order. */
  failedShipmentIds: string[];
}

export type PurgeEvaluation =
  | { eligible: true; preview: PurgePreview }
  | { eligible: false; reasons: string[] };

/** A shipment that never became a carrier parcel — same rule as deleteFailedShipmentAction. */
export const isFailedShipmentAttempt = (s: { status: ShipmentStatus; externalId: string | null }) =>
  s.status === "ECHEC" && !s.externalId;

export function evaluateOrderPurge(order: PurgeOrderSnapshot): PurgeEvaluation {
  const reasons: string[] = [];
  if (order.source !== "INTERNE") {
    reasons.push("Commande importée d'une boutique (WooCommerce / Shopify) : elle serait réimportée — annulez-la plutôt.");
  }
  if (!PURGEABLE_STATUSES.includes(order.status)) {
    reasons.push("Seule une commande Nouvelle, Confirmée, en Emballage ou Annulée (jamais expédiée) peut être purgée.");
  }
  if (order.shippedAt) {
    reasons.push("La commande a déjà été expédiée : le stock a été déduit — utilisez un retour physique.");
  }
  const parcels = order.shipments.filter((s) => s.externalId);
  if (parcels.length > 0) {
    reasons.push(
      `Un colis existe chez le transporteur (${parcels.map((s) => s.trackingNumber ?? s.externalId).join(", ")}) : annulez-le dans le portail du transporteur ; la commande peut seulement être annulée.`
    );
  }
  if (order.shipments.some((s) => !s.externalId && !isFailedShipmentAttempt(s))) {
    reasons.push("Une expédition (manuelle ou en cours) est enregistrée pour cette commande.");
  }
  if (order.refundCount > 0) reasons.push("Un remboursement est enregistré pour cette commande.");
  if (order.returnCount > 0) reasons.push("Un retour physique est enregistré pour cette commande.");
  if (order.commissionEntryCount > 0) reasons.push("Une commission est enregistrée pour cette commande.");
  if (reasons.length > 0) return { eligible: false, reasons };

  const releaseReservation = orderHoldsReservation(order.status);
  return {
    eligible: true,
    preview: {
      releaseReservation,
      releasedLines: releaseReservation
        ? order.items
            .filter((i) => i.quantity > 0 && (i.productId || i.variationId))
            .map((i) => ({ name: i.nameSnapshot, sku: i.skuSnapshot, quantity: i.quantity }))
        : [],
      failedShipmentIds: order.shipments.filter(isFailedShipmentAttempt).map((s) => s.id),
    },
  };
}
