import "server-only";

import type { ShipmentStatusValue } from "@/lib/validation/delivery";

/**
 * ⚠️ PROVISIONAL Sendit → local ShipmentStatus mapping.
 *
 * This table MUST be reviewed and approved by the owner before Sendit is
 * activated live. It was derived from the Swagger status catalogue only —
 * no live parcel has been observed. Notably debatable: UNREACHABLE /
 * POSTPONED as EN_TRANSIT, CANCELED / REJECTED as ECHEC, and whether
 * RETOUR_PENDING / TORETURN / RETURN_WAREHOUSE / RETURN_TOCHECK should
 * already count as a return.
 */
export const SENDIT_STATUS_MAPPING_STATUS = "PROVISIONAL_PENDING_OWNER_REVIEW" as const;

/** French labels from GET /all-status-deliveries. SCHEDULED appears only in
 * the schema description, quoted verbatim. */
export const SENDIT_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: "En attente",
  TO_PREPARE: "À préparer",
  NEW_DESTINATION: "À changer",
  TO_PICKUP: "Ramassage en cours",
  PICKEDUP: "Ramassé",
  WAREHOUSE: "Entrepôt",
  TRANSIT: "En transit",
  DISTRIBUTED: "Distribué",
  UNREACHABLE: "Injoignable",
  POSTPONED: "Reporté",
  DELIVERING: "En cours de livraison",
  DELIVERED: "Livré",
  CANCELED: "Annulé",
  REJECTED: "Refusé",
  SCHEDULED: "La livraison du colis a été programmée",
};

export const SENDIT_STATUSES = Object.keys(SENDIT_STATUS_LABELS);

/** Documented `status_return` values. */
export const SENDIT_RETURN_STATUSES = [
  "RETOUR_PENDING",
  "TORETURN",
  "RETURN_WAREHOUSE",
  "RETURN_TOCHECK",
  "RETURN_STOCK",
  "RETURN_SELLER",
] as const;

const STATUS_MAP: Readonly<Record<string, ShipmentStatusValue>> = {
  PENDING: "EN_ATTENTE",
  TO_PREPARE: "EN_ATTENTE",
  TO_PICKUP: "EN_ATTENTE",
  NEW_DESTINATION: "EN_ATTENTE",
  PICKEDUP: "EN_TRANSIT",
  WAREHOUSE: "EN_TRANSIT",
  TRANSIT: "EN_TRANSIT",
  DISTRIBUTED: "EN_TRANSIT",
  DELIVERING: "EN_TRANSIT",
  SCHEDULED: "EN_TRANSIT",
  POSTPONED: "EN_TRANSIT",
  UNREACHABLE: "EN_TRANSIT",
  DELIVERED: "LIVRE",
  CANCELED: "ECHEC",
  REJECTED: "ECHEC",
};

/** Only these two return states take precedence over `status`. */
const RETURN_PRECEDENCE: ReadonlySet<string> = new Set(["RETURN_STOCK", "RETURN_SELLER"]);

function norm(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

/** PROVISIONAL — see header. Returns null for an unknown status (caller
 * keeps the raw string, never guesses). */
export function mapSenditStatus(
  status: string | null | undefined,
  statusReturn?: string | null
): ShipmentStatusValue | null {
  if (RETURN_PRECEDENCE.has(norm(statusReturn))) return "RETOURNE";
  return STATUS_MAP[norm(status)] ?? null;
}

export function senditStatusLabel(status: string | null | undefined): string | null {
  return SENDIT_STATUS_LABELS[norm(status)] ?? null;
}

/**
 * Sendit reports two fields (`status` + `status_return`); the shared adapter
 * contract carries one raw string. Both are kept verbatim, joined by « / »
 * when a return state is present (e.g. "REJECTED/RETURN_STOCK").
 */
export const SENDIT_RAW_STATUS_SEPARATOR = "/";

export function composeSenditRawStatus(status: string, statusReturn?: string | null): string {
  const s = status.trim();
  const r = typeof statusReturn === "string" ? statusReturn.trim() : "";
  return r ? `${s}${SENDIT_RAW_STATUS_SEPARATOR}${r}` : s;
}

/** PROVISIONAL — maps a raw string built by composeSenditRawStatus. */
export function mapSenditRawStatus(raw: string): ShipmentStatusValue | null {
  const [status, statusReturn] = raw.split(SENDIT_RAW_STATUS_SEPARATOR);
  return mapSenditStatus(status, statusReturn ?? null);
}
