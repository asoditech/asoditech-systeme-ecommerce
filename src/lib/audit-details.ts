import { SHIPMENT_STATUS_LABELS } from "@/lib/status-labels";

/**
 * The few audit-event details worth showing next to the action label
 * (order « Historique », Journal d'audit). A WHITELIST per action — an
 * event's metadata is never dumped as is (it can hold technical or personal
 * data, e.g. the email of a failed login) — each value read defensively,
 * since the JSON columns are untyped.
 */

type Json = unknown;

/** The only actions whose details are ever shown (their payloads hold no cost or personal data). */
export const AUDIT_DETAIL_ACTIONS: readonly string[] = ["order.return_reception_cancelled", "order.status_changed"];

function field(obj: Json, key: string): string | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

export function auditEventDetails(event: { action: string; metadata?: Json; previousValue?: Json }): string[] {
  switch (event.action) {
    case "order.return_reception_cancelled": {
      const details: string[] = [];
      const reason = field(event.metadata, "reasonLabel") ?? field(event.metadata, "reason");
      if (reason) details.push(`Motif : ${reason}`);
      const note = field(event.metadata, "note");
      if (note) details.push(`Note : ${note}`);
      const tracking = field(event.previousValue, "trackingNumber");
      if (tracking) details.push(`Colis : ${tracking}`);
      return details;
    }
    case "order.status_changed": {
      if (field(event.metadata, "via") !== "shipment") return [];
      const status = field(event.metadata, "shipmentStatus");
      const label = status ? (SHIPMENT_STATUS_LABELS[status]?.label ?? status) : null;
      return [label ? `Automatique : expédition passée « ${label} »` : "Automatique : suite à l'expédition"];
    }
    default:
      return [];
  }
}
