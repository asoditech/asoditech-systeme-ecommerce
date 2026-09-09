/**
 * Normalized tracking-status layer for the « Suivi » module
 * (docs/adr/0033). Client-safe (no server-only) — used by both the query
 * layer and the table component.
 *
 * This does NOT replace `ShipmentStatus` — the local shipment state
 * machine is untouched. It is a finer-grained *display* layer on top of
 * `ShipmentStatus` + the carrier's raw string, so a new carrier plugs
 * into the same UI. The carrier's original status is always kept
 * alongside (`providerStatusRaw`) and never overwritten.
 */

export type NormalizedTrackingStatus =
  | "CREATED"
  | "PICKUP_PENDING"
  | "PICKED_UP"
  | "IN_TRANSIT"
  | "AT_DEPOT"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "RETURNED"
  | "FAILED"
  | "CANCELLED"
  | "UNKNOWN";

export const NORMALIZED_TRACKING_LABELS: Record<NormalizedTrackingStatus, string> = {
  CREATED: "Créé",
  PICKUP_PENDING: "En attente de ramassage",
  PICKED_UP: "Ramassé",
  IN_TRANSIT: "En transit",
  AT_DEPOT: "Au dépôt",
  OUT_FOR_DELIVERY: "En cours de livraison",
  DELIVERED: "Livré",
  RETURNED: "Retourné",
  FAILED: "Échec",
  CANCELLED: "Annulé",
  UNKNOWN: "Statut inconnu",
};

/** Badge tone, aligned with the app's `StatusMeta.variant`. */
export const NORMALIZED_TRACKING_VARIANT: Record<
  NormalizedTrackingStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  CREATED: "secondary",
  PICKUP_PENDING: "secondary",
  PICKED_UP: "default",
  IN_TRANSIT: "default",
  AT_DEPOT: "default",
  OUT_FOR_DELIVERY: "default",
  DELIVERED: "default",
  RETURNED: "destructive",
  FAILED: "destructive",
  CANCELLED: "outline",
  UNKNOWN: "outline",
};

type LocalShipmentStatus = "EN_ATTENTE" | "EN_TRANSIT" | "LIVRE" | "ECHEC" | "RETOURNE" | "ANNULE";

/** Keyword refinements applied to a carrier's raw status while the local
 * status is still non-terminal (EN_ATTENTE / EN_TRANSIT). Order matters —
 * first match wins. Accent-insensitive, lower-cased before matching. */
const RAW_REFINEMENTS: { re: RegExp; status: NormalizedTrackingStatus }[] = [
  { re: /out for delivery|en cours de livraison|mise en distribution|with delivery|distribution/, status: "OUT_FOR_DELIVERY" },
  // Checked before PICKED_UP so "en attente de ramassage" isn't caught by "ramass".
  { re: /attente de ramassage|awaiting pickup|awaiting collection|pickup pending|pickup requested|ramassage demande|nouveau colis|new parcel|shipment created|information received|enregistr/, status: "PICKUP_PENDING" },
  { re: /depot|warehouse|hub|centre de tri|facility|au bureau/, status: "AT_DEPOT" },
  { re: /picked up|ramasse|pris en charge|collected|recu|received/, status: "PICKED_UP" },
  { re: /in transit|en transit|shipped|expedi|depart|departed|arrive/, status: "IN_TRANSIT" },
];

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Derive the normalized status. The authoritative signal is the local
 * `ShipmentStatus` (which the existing sync keeps correct); the carrier's
 * raw string only refines the two non-terminal buckets into a nicer
 * label. A terminal local status is never overridden by raw text.
 */
export function normalizeTrackingStatus(
  localStatus: LocalShipmentStatus,
  providerStatusRaw: string | null | undefined
): NormalizedTrackingStatus {
  switch (localStatus) {
    case "LIVRE":
      return "DELIVERED";
    case "RETOURNE":
      return "RETURNED";
    case "ECHEC":
      return "FAILED";
    case "ANNULE":
      return "CANCELLED";
    default:
      break;
  }

  const raw = stripAccents((providerStatusRaw ?? "").toLowerCase().trim());
  if (raw) {
    for (const { re, status } of RAW_REFINEMENTS) {
      if (re.test(raw)) return status;
    }
  }
  // No usable raw string: fall back to the coarse local bucket.
  return localStatus === "EN_TRANSIT" ? "IN_TRANSIT" : "CREATED";
}

export function normalizedTrackingLabel(status: NormalizedTrackingStatus): string {
  return NORMALIZED_TRACKING_LABELS[status];
}
