import "server-only";

import type { ShipmentStatusValue } from "@/lib/validation/delivery";

/**
 * ⚠️ PROVISIONAL Ameex → local ShipmentStatus mapping.
 *
 * The catalogue itself is REAL: the 36 codes below are exactly what
 * GET /Delivery/Parcels/Statuts returned on the Ameex sandbox on 2026-10-16
 * (tests/fixtures/ameex/sandbox-responses-2026-10-16.json). The MAPPING to
 * local statuses is ours and MUST be reviewed by the owner before Ameex is
 * used on production parcels — only one sandbox parcel (NEW_PARCEL) has
 * ever been observed.
 *
 * Catalogue structure (observed): codes of `type: "fixed"` are main
 * statuses (`statut`); codes of `type: "in_progress"` are the sub-statuses
 * Ameex sends in `statut_s` while the main status is IN_PROGRESS (the
 * webhook doc says the same: STATUT_S only for IN_PROGRESS).
 *
 * Every chosen transition is legal in SHIPMENT_STATUS_TRANSITIONS
 * (src/lib/validation/delivery.ts) — checked by tests/lib/ameex-status.test.ts:
 *  - refusal-type sub-statuses → ECHEC. ECHEC → RETOURNE is legal, so a
 *    later RETURNED still lands; ECHEC → EN_TRANSIT is legal, so a RELAUNCH
 *    after a refusal re-activates the shipment.
 *  - PREPAR_RETURN → EN_TRANSIT (return not final until RETURNED). Review
 *    point: after a REFUSE (ECHEC) this flips the shipment back to
 *    EN_TRANSIT until RETURNED arrives.
 *  - REFUNDED → null: ambiguous (COD remitted to the merchant? refund to
 *    the customer?) — the raw status is kept, nothing is guessed.
 *  - Unknown code (main or sub) → null.
 */
export const AMEEX_STATUS_MAPPING_STATUS = "PROVISIONAL_PENDING_OWNER_REVIEW" as const;

/** Sandbox catalogue (2026-10-16): code → French name, verbatim. */
export const AMEEX_STATUS_LABELS: Readonly<Record<string, string>> = {
  DELIVERED: "Livré",
  DISPOSITION: "Mis à disposition",
  DISTRIBUTION: "Mise en distribution",
  DRAFT: "Brouillon",
  IN_PROGRESS: "En cours",
  IN_SHIPMENT: "En cours d'expédition",
  NEW_PARCEL: "Nouveau Colis",
  PICKED_UP: "Ramassé",
  RECEIVED: "Reçu",
  REFUNDED: "Remboursé",
  RELAUNCH: "Relancer",
  RELAUNCH_NEW: "Relancer vers un nouveau client",
  RELAUNCH_TEAM: "Relancer ( Suivi )",
  RESEND_NEW_CITY: "Renvoyez vers nouvelle ville",
  RETURNED: "Retourné",
  SENT: "Expédié",
  WAITING_PICKUP: "Attente De Ramassage",
  CANCELED: "Annulé",
  CANCELED_TEAM: "Annulé ( Suivi )",
  CONFIRMED_BY_LIVREUR: "Confirmé Par Livreur",
  DOESNT_ORDER: "Client n'a pas commandé",
  NO_ANSWER: "Pas de réponse",
  NO_ANSWER_SMS: "Pas de réponse + SMS",
  NO_ANSWER_TEAM: "Pas de réponse ( Suivi )",
  OUT_OF_AREA: "Hors-zone",
  POSTPONED: "Reporté",
  POSTPONED_TEAM: "Reporté ( Suivi )",
  PREPAR_RETURN: "PRÉPARATION RETOUR",
  REFUSE: "Refusé",
  SCHEDULED: "Programmé",
  TRAVELLING: "En Voyage",
  UNREACHABLE: "Injoignable",
  UNREACHABLE_TEAM: "Injoignable ( Suivi )",
  VOICEMAIL: "Boîte vocale",
  VOICEMAIL_TEAM: "Boîte vocale ( Suivi )",
  WRONG_NUMBER: "Numéro Incorrect",
};

export const AMEEX_STATUSES = Object.keys(AMEEX_STATUS_LABELS);

/** PROVISIONAL — see header. `null` entries are deliberate (never guessed). */
export const AMEEX_STATUS_MAP: Readonly<Record<string, ShipmentStatusValue | null>> = {
  // Not yet handed to Ameex.
  DRAFT: "EN_ATTENTE",
  NEW_PARCEL: "EN_ATTENTE",
  WAITING_PICKUP: "EN_ATTENTE",
  // With Ameex, not final.
  PICKED_UP: "EN_TRANSIT",
  RECEIVED: "EN_TRANSIT",
  IN_SHIPMENT: "EN_TRANSIT",
  SENT: "EN_TRANSIT",
  TRAVELLING: "EN_TRANSIT",
  DISTRIBUTION: "EN_TRANSIT",
  IN_PROGRESS: "EN_TRANSIT",
  CONFIRMED_BY_LIVREUR: "EN_TRANSIT",
  SCHEDULED: "EN_TRANSIT",
  DISPOSITION: "EN_TRANSIT",
  POSTPONED: "EN_TRANSIT",
  POSTPONED_TEAM: "EN_TRANSIT",
  NO_ANSWER: "EN_TRANSIT",
  NO_ANSWER_SMS: "EN_TRANSIT",
  NO_ANSWER_TEAM: "EN_TRANSIT",
  UNREACHABLE: "EN_TRANSIT",
  UNREACHABLE_TEAM: "EN_TRANSIT",
  VOICEMAIL: "EN_TRANSIT",
  VOICEMAIL_TEAM: "EN_TRANSIT",
  RELAUNCH: "EN_TRANSIT",
  RELAUNCH_NEW: "EN_TRANSIT",
  RELAUNCH_TEAM: "EN_TRANSIT",
  RESEND_NEW_CITY: "EN_TRANSIT",
  PREPAR_RETURN: "EN_TRANSIT",
  // Final outcomes.
  DELIVERED: "LIVRE",
  RETURNED: "RETOURNE",
  // Delivery failed (the parcel will come back — RETURNED may follow).
  REFUSE: "ECHEC",
  CANCELED: "ECHEC",
  CANCELED_TEAM: "ECHEC",
  DOESNT_ORDER: "ECHEC",
  WRONG_NUMBER: "ECHEC",
  OUT_OF_AREA: "ECHEC",
  // Ambiguous — raw kept.
  REFUNDED: null,
};

function norm(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

/**
 * Ameex reports a main status plus, under IN_PROGRESS, a sub-status. The
 * shared adapter contract carries one raw string: both are kept verbatim,
 * joined by « / » when a sub-status is present (e.g. "IN_PROGRESS/REFUSE").
 */
export const AMEEX_RAW_STATUS_SEPARATOR = "/";

export function composeAmeexRawStatus(status: string, subStatus?: string | null): string {
  const s = status.trim();
  const sub = typeof subStatus === "string" ? subStatus.trim() : "";
  return sub ? `${s}${AMEEX_RAW_STATUS_SEPARATOR}${sub}` : s;
}

/**
 * PROVISIONAL. The sub-status is only considered under IN_PROGRESS (where
 * Ameex documents/sends it); there it decides, and an UNKNOWN sub-status →
 * null (it could be a refusal — never assumed to be « en cours »).
 */
export function mapAmeexStatus(status: string | null | undefined, subStatus?: string | null): ShipmentStatusValue | null {
  const main = norm(status);
  const sub = norm(subStatus);
  if (main === "IN_PROGRESS" && sub) {
    return AMEEX_STATUS_MAP[sub] ?? null;
  }
  return AMEEX_STATUS_MAP[main] ?? null;
}

/** PROVISIONAL — maps a raw string built by composeAmeexRawStatus. */
export function mapAmeexRawStatus(raw: string): ShipmentStatusValue | null {
  const [status, subStatus] = raw.split(AMEEX_RAW_STATUS_SEPARATOR);
  return mapAmeexStatus(status, subStatus ?? null);
}

export function ameexStatusLabel(code: string | null | undefined): string | null {
  return AMEEX_STATUS_LABELS[norm(code)] ?? null;
}
