import "server-only";

import {
  DeliveryAuthError,
  DeliveryConfigError,
  DeliveryMalformedResponseError,
} from "@/lib/integrations/delivery/errors";
import type { AdapterTrackingEvent, CreateShipmentAdapterInput, DeliveryCity } from "@/lib/integrations/delivery/types";
import { composeAmeexRawStatus } from "./status";

/**
 * Ameex ↔ local-model translation — PURE (no network). Every shape below
 * was observed on the Ameex SANDBOX on 2026-10-16
 * (tests/fixtures/ameex/sandbox-responses-2026-10-16.json). Production
 * responses have not been observed yet.
 */

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  if (typeof value === "string") {
    const t = value.trim();
    return t === "" ? null : t;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

// ---------------------------------------------------------------------------
// Envelope: { login: "success", api: { type: "success" | "error", msg, … } }
// ---------------------------------------------------------------------------

/**
 * Known Ameex refusal messages → a fixed French hint. Ameex's `msg` is
 * NEVER echoed as such (it is free text and could one day carry customer
 * data); only a field NAME extracted by a strict pattern is ever shown.
 */
function refusalMessage(msg: string | null): string {
  const m = msg ?? "";
  if (/unknown city/i.test(m)) {
    return "Ameex a refusé le colis : ville inconnue. Vérifiez la correspondance de villes de ce prestataire (liste des villes Ameex), puis réessayez.";
  }
  const required = /^The ([a-z_]{1,40}) field is required\.?$/i.exec(m.trim());
  if (required) {
    return `Ameex a refusé la requête : champ obligatoire manquant (« ${required[1].toLowerCase()} »).`;
  }
  return "Ameex a refusé la requête (données invalides ou incomplètes). Vérifiez la commande et réessayez.";
}

/**
 * Validates the envelope and returns `api`.
 *  - `login` other than "success" → DeliveryAuthError;
 *  - `api.type === "error"` (Ameex answers business errors with HTTP 200)
 *    → DeliveryConfigError with a fixed French message (+ mapped hint);
 *  - anything unrecognizable → DeliveryMalformedResponseError.
 */
export function assertAmeexEnvelope(raw: unknown): Obj {
  if (!isObj(raw)) throw new DeliveryMalformedResponseError("Réponse Ameex illisible (enveloppe inattendue).");
  if ("login" in raw && raw.login !== "success") {
    throw new DeliveryAuthError(
      "Authentification refusée par Ameex — vérifiez l'identifiant API (C-Api-Id) et la clé API (C-Api-Key)."
    );
  }
  if (raw.login !== "success") throw new DeliveryMalformedResponseError("Réponse Ameex illisible (enveloppe inattendue).");
  const api = raw.api;
  if (!isObj(api)) throw new DeliveryMalformedResponseError("Réponse Ameex illisible (enveloppe inattendue).");
  if (api.type === "error") throw new DeliveryConfigError(refusalMessage(str(api.msg)));
  if (api.type !== "success") throw new DeliveryMalformedResponseError("Réponse Ameex illisible (enveloppe inattendue).");
  return api;
}

// ---------------------------------------------------------------------------
// GET /Delivery/Parcels/Statuts
// ---------------------------------------------------------------------------

/** Number of status codes in the catalogue (connection-test detail). */
export function countAmeexStatuses(api: Obj): number {
  const data = api.data;
  const status = isObj(data) ? data.status : null;
  if (!isObj(status)) throw new DeliveryMalformedResponseError("Catalogue des statuts Ameex illisible.");
  return Object.keys(status).length;
}

// ---------------------------------------------------------------------------
// GET /Delivery/Cities → api.cities = { "<id>": { id, name } }
// ---------------------------------------------------------------------------

export function parseAmeexCities(api: Obj): DeliveryCity[] {
  const cities = api.cities;
  if (!isObj(cities)) throw new DeliveryMalformedResponseError("Liste des villes Ameex illisible.");
  const out: DeliveryCity[] = [];
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(cities)) {
    if (!isObj(value)) continue;
    const id = str(value.id) ?? str(key);
    const name = str(value.name);
    if (!id || !name || !/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, region: null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// POST /Delivery/Parcels/Action/Type/Add — form-encoded (JSON is refused:
// sandbox answered « The receiver field is required. » to a JSON body).
// ---------------------------------------------------------------------------

export type AmeexAddParcelForm = Record<string, string>;

function formatCod(amount: number): string {
  return String(Math.round(amount * 100) / 100);
}

/**
 * Builds the form body with the fields the sandbox accepted: type=SIMPLE,
 * receiver, phone, city (Ameex city id), cod, address, product, comment,
 * order_num. Throws DeliveryConfigError BEFORE anything is sent when the
 * city id or the COD amount is unusable.
 *  - cod = the COD amount, or 0 for a non-COD order (0 not yet observed on
 *    the sandbox — open point in docs/carriers/ameex.md);
 *  - product = the parcel contents, else « Commande <n° de commande> »;
 *  - comment omitted when there is no note.
 */
export function buildAmeexAddParcelForm(input: CreateShipmentAdapterInput, cityId: string | null): AmeexAddParcelForm {
  const city = (cityId ?? "").trim();
  if (!/^\d+$/.test(city) || Number(city) <= 0) {
    throw new DeliveryConfigError(
      "Ville non reconnue chez Ameex — ajoutez une correspondance de villes pour ce prestataire (liste des villes Ameex), puis réessayez."
    );
  }
  const cod = input.codAmount ?? 0;
  if (typeof cod !== "number" || !Number.isFinite(cod) || cod < 0) {
    throw new DeliveryConfigError("Le montant à encaisser du colis Ameex doit être un nombre positif ou nul.");
  }
  const address = [input.addressLine1, input.addressLine2]
    .map((l) => (typeof l === "string" ? l.trim() : ""))
    .filter((l) => l !== "")
    .join(", ");
  const orderNum = input.orderNumber.trim();

  const form: AmeexAddParcelForm = {
    type: "SIMPLE",
    receiver: input.recipientName.trim(),
    phone: (input.phone ?? "").trim(),
    city,
    cod: formatCod(cod),
    address,
    product: input.parcelContents?.trim() || `Commande ${orderNum}`,
    order_num: orderNum,
  };
  const comment = input.notes?.trim();
  if (comment) form.comment = comment;
  return form;
}

/** `api.data.code` of a successful Add. Missing → malformed (the caller
 * turns that into an UNKNOWN outcome: the parcel may exist). */
export function parseAmeexAddParcelCode(api: Obj): string {
  const data = api.data;
  const code = isObj(data) ? str(data.code) : null;
  if (!code) throw new DeliveryMalformedResponseError("Réponse de création Ameex sans code de colis.");
  return code;
}

// ---------------------------------------------------------------------------
// GET /Delivery/Parcels/Tracking/ParcelCode/{code} → api.tracking = [ … ]
// ---------------------------------------------------------------------------

export interface AmeexTrackingEvent {
  statut: string;
  statutName: string | null;
  statutS: string | null;
  statutSName: string | null;
  /** Unix SECONDS (observed), null if unparseable. */
  sortingTime: number | null;
  comment: string | null;
}

function toSeconds(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{1,12}$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseEventList(list: unknown): AmeexTrackingEvent[] {
  if (!Array.isArray(list)) throw new DeliveryMalformedResponseError("Historique de suivi Ameex illisible.");
  const out: AmeexTrackingEvent[] = [];
  for (const e of list) {
    if (!isObj(e)) continue;
    const statut = str(e.statut);
    if (!statut) continue;
    out.push({
      statut,
      statutName: str(e.statut_name),
      statutS: str(e.statut_s),
      statutSName: str(e.statut_s_name),
      sortingTime: toSeconds(e.sorting_time) ?? toSeconds(e.time),
      comment: str(e.comment),
    });
  }
  return out;
}

/** Events sorted oldest-first by `sorting_time` (stable: equal / missing
 * times keep Ameex's array order; untimed events sort first). */
export function parseAmeexTracking(api: Obj): AmeexTrackingEvent[] {
  const events = parseEventList(api.tracking);
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.sortingTime ?? -1) - (b.e.sortingTime ?? -1) || a.i - b.i)
    .map(({ e }) => e);
}

/** The latest event by `sorting_time`; throws when there is none. */
export function latestAmeexEvent(events: AmeexTrackingEvent[]): AmeexTrackingEvent {
  const last = events[events.length - 1];
  if (!last) throw new DeliveryMalformedResponseError("Réponse de suivi Ameex sans statut de colis.");
  return last;
}

export function ameexEventRawStatus(e: AmeexTrackingEvent): string {
  return composeAmeexRawStatus(e.statut, e.statutS);
}

function isoFromSeconds(s: number | null): string | null {
  if (s === null) return null;
  const d = new Date(s * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function toAdapterTrackingEvent(e: AmeexTrackingEvent): AdapterTrackingEvent {
  return {
    rawStatus: ameexEventRawStatus(e),
    label: e.statutSName ?? e.statutName,
    description: e.comment,
    location: null,
    timestamp: isoFromSeconds(e.sortingTime),
  };
}

export function ameexEventTimestamp(e: AmeexTrackingEvent): string | null {
  return isoFromSeconds(e.sortingTime);
}
