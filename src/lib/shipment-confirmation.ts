/**
 * Confirmation before a carrier shipment is created — client-safe helpers
 * shared by the single « Créer une expédition » dialog and the bulk
 * « Créer les expéditions » action (src/components/delivery/).
 *
 * The dialog only adds a human check BEFORE the carrier API is called. It
 * does not change the server's own guarantees (eligibility, packing,
 * advisory-locked `reserveShipmentSlot`) and it does NOT solve the carrier's
 * missing idempotency key (docs/adr/0013): when a call times out or the
 * carrier answers 5xx, the parcel may already exist on the carrier's side —
 * hence `CARRIER_UNCERTAIN_RETRY_WARNING`.
 */

/** Appended to a creation error whose outcome on the carrier's side is unknown. */
export const CARRIER_UNCERTAIN_RETRY_WARNING =
  "Le colis a peut-être été créé chez le transporteur malgré cette erreur : vérifiez son portail avant de réessayer, " +
  "et utilisez « Lier un colis existant » s'il y figure déjà.";

/** The COD amount the shipment will ask the carrier to collect — same rule as `createShipmentViaProvider`. */
export function shipmentCodAmount(paymentMethod: string, total: number | string): number | null {
  if (paymentMethod !== "PAIEMENT_LIVRAISON") return null;
  const n = Number(total);
  return Number.isFinite(n) ? n : null;
}

export interface SingleShipmentSummary {
  providerName: string;
  recipientName: string;
  city: string | null;
  /** null = prepaid order, nothing to collect. */
  codAmount: number | null;
  currency: string;
  lineCount: number;
}

export interface BulkShipmentSummary {
  providerName: string;
  shipmentCount: number;
  /** Total COD to collect, per currency (normally one: MAD). Prepaid orders add nothing. */
  codTotals: { currency: string; amount: number }[];
}

export function bulkShipmentSummary(
  providerName: string,
  orders: { codAmount: number | null; currency: string }[]
): BulkShipmentSummary {
  const totals = new Map<string, number>();
  for (const o of orders) {
    if (o.codAmount === null) continue;
    totals.set(o.currency, Math.round(((totals.get(o.currency) ?? 0) + o.codAmount) * 100) / 100);
  }
  return {
    providerName,
    shipmentCount: orders.length,
    codTotals: [...totals.entries()].map(([currency, amount]) => ({ currency, amount })),
  };
}

/**
 * Holds one pending submission until the user confirms. `confirm` runs the
 * submit callback at most once per request (a double click on « Confirmer »
 * is a no-op), `cancel` drops it — nothing is submitted, so no carrier call.
 */
export function createConfirmGate<T>() {
  let pending: { payload: T } | null = null;
  return {
    request(payload: T) {
      pending = { payload };
    },
    hasPending(): boolean {
      return pending !== null;
    },
    cancel() {
      pending = null;
    },
    confirm(submit: (payload: T) => void): boolean {
      if (pending === null) return false;
      const { payload } = pending;
      pending = null;
      submit(payload);
      return true;
    },
  };
}

export type ConfirmGate<T> = ReturnType<typeof createConfirmGate<T>>;
