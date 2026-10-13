import type { ReturnParcelState } from "@/lib/queries/return-receiving";
import type { ReceiveParcelResult } from "@/lib/returns/reception";

/**
 * Returns workspace (/livraison/retours) — row selection + « Réceptionner la
 * sélection ». Pure rules shared by the table and its tests:
 *  - only a parcel that can be RECEIVED now (carrier « Retourné », stage « À
 *    réceptionner ») is selectable — a pending or inspected parcel has its own
 *    single, explicit action (Inspecter / Nouvelle réception);
 *  - the batch result is summarized per outcome, never as a blanket success
 *    when one parcel failed. Inspection stays per parcel: it needs a condition
 *    (revendable / endommagé) for every unit, so there is no bulk inspection.
 */
export const BULK_RECEIVE_MAX = 50; // same cap as receiveReturnParcelsSchema

export function isBulkReceivable(parcel: { eligible: boolean; state: ReturnParcelState }): boolean {
  return parcel.eligible && parcel.state === "A_RECEPTIONNER";
}

/** « Prochaine étape » shown on each row. */
export function returnParcelNextStep(parcel: { eligible: boolean; state: ReturnParcelState; remainingUnits: number }): string {
  if (!parcel.eligible && parcel.state === "A_RECEPTIONNER") return "Non éligible (le transporteur n'indique pas « Retourné »)";
  switch (parcel.state) {
    case "A_RECEPTIONNER":
      return "Réceptionner le colis";
    case "A_INSPECTER":
      return "Inspecter les articles";
    case "INSPECTE":
      return parcel.remainingUnits > 0 ? `Terminé · ${parcel.remainingUnits} unité(s) encore attendue(s)` : "Terminé";
    case "DEJA_RETOURNE":
      return "Rien à faire (déjà retourné)";
  }
}

export interface BulkReceiveSummary {
  received: number;
  alreadyPending: number;
  failed: { shipmentId: string; error: string }[];
  /** True only when EVERY parcel was received (or was already pending). */
  allOk: boolean;
  message: string;
}

export function summarizeBulkReceive(items: { shipmentId: string; result: ReceiveParcelResult }[]): BulkReceiveSummary {
  let received = 0;
  let alreadyPending = 0;
  const failed: { shipmentId: string; error: string }[] = [];
  for (const { shipmentId, result } of items) {
    if (!result.ok) failed.push({ shipmentId, error: result.error });
    else if (result.status === "already_pending") alreadyPending++;
    else received++;
  }
  const parts = [`${received} réceptionné(s)`];
  if (alreadyPending) parts.push(`${alreadyPending} déjà réceptionné(s)`);
  if (failed.length) parts.push(`${failed.length} en erreur`);
  return { received, alreadyPending, failed, allOk: failed.length === 0 && items.length > 0, message: `${parts.join(", ")}.` };
}
