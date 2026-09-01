import "server-only";

import { DeliveryConfigError, DeliveryMalformedResponseError } from "@/lib/integrations/delivery/errors";
import type { ShipmentStatusValue } from "@/lib/validation/delivery";
import { parseMoney } from "./client";
import {
  ozonExpressAddParcelResponseSchema,
  ozonExpressCitiesResponseSchema,
  ozonExpressParcelBodySchema,
  ozonExpressTrackingResponseSchema,
  type OzonExpressConfig,
} from "./types";
import type { CreateShipmentAdapterInput, DeliveryCity } from "@/lib/integrations/delivery/types";

/**
 * OzonExpress ↔ local-model translation. All carrier-specific vocabulary
 * lives here (docs/adr/0012 "Status synchronization": mapping is
 * adapter-owned, never a shared guess table).
 *
 * See docs/adr/0013-ozonexpress-integration.md.
 */

// ---------------------------------------------------------------------------
// GET /cities — destination catalogue
// ---------------------------------------------------------------------------

/**
 * One OzonExpress destination, as returned by `GET /cities` (confirmed
 * live 2026-09-01): `{ ID, REF, NAME, "DELIVERED-PRICE", "RETURNED-PRICE",
 * "REFUSED-PRICE" }`. The delivery price here is authoritative — it is
 * what OzonExpress bills on delivery to that city.
 */
export interface OzonExpressCity {
  id: string;
  name: string;
  ref: string | null;
  deliveredPrice: number | null;
  returnedPrice: number | null;
  refusedPrice: number | null;
}

/**
 * Parses a `GET /cities` body into `OzonExpressCity[]`. The confirmed
 * shape is `{ CITIES: { "<id>": {ID,REF,NAME,DELIVERED-PRICE,…} } }` — an
 * object keyed by id — but a bare array and the other envelope keys
 * (`cities` / `result` / `data`) are tolerated too. An entry missing an id
 * or a name is dropped, never guessed. Returns `[]` for an unrecognisable
 * body rather than throwing.
 */
export function parseOzonExpressCities(raw: unknown): OzonExpressCity[] {
  const parsed = ozonExpressCitiesResponseSchema.safeParse(raw);
  if (!parsed.success) return [];

  const container = Array.isArray(parsed.data)
    ? parsed.data
    : parsed.data.CITIES ?? parsed.data.cities ?? parsed.data.result ?? parsed.data.data ?? [];
  // CITIES is an object keyed by id in the live response; Object.values
  // handles that and passes an array straight through.
  const list = Array.isArray(container) ? container : Object.values(container);

  const cities: OzonExpressCity[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const idRaw = e.ID ?? e.id ?? e.CITY_ID ?? e.ref ?? e.REF;
    const name = (e.NAME ?? e.name ?? e.CITY_NAME ?? e.ville ?? e.VILLE) as string | undefined;
    if (idRaw === undefined || idRaw === null || !name) continue;
    const id = String(idRaw).trim();
    if (!id) continue;
    cities.push({
      id,
      name: String(name).trim(),
      ref: e.REF !== undefined ? String(e.REF) : e.ref !== undefined ? String(e.ref) : null,
      deliveredPrice: parseMoney(e["DELIVERED-PRICE"]),
      returnedPrice: parseMoney(e["RETURNED-PRICE"]),
      refusedPrice: parseMoney(e["REFUSED-PRICE"]),
    });
  }
  return cities;
}

/** Generic view for the shared `listCities` capability. */
export function toDeliveryCities(cities: OzonExpressCity[]): DeliveryCity[] {
  return cities.map((c) => ({ id: c.id, name: c.name, region: null }));
}

/** Back-compat: parse straight to `DeliveryCity[]`. */
export function parseCitiesResponse(raw: unknown): DeliveryCity[] {
  return toDeliveryCities(parseOzonExpressCities(raw));
}

// ---------------------------------------------------------------------------
// Outbound: local order → add-parcel form fields
// ---------------------------------------------------------------------------

export type CityLike = { id: string; name: string; deliveredPrice?: number | null };

/**
 * Resolves the recipient city to an OzonExpress city id + its
 * authoritative delivery price. Resolution order:
 *   1. an explicit `config.cityIdByName` override (operator correction), then
 *   2. the `GET /cities` catalogue, matched case-insensitively on name.
 * Throws a typed config error (never guesses an id) when neither resolves.
 */
export function resolveCity(
  city: string,
  config: OzonExpressConfig,
  catalogue: readonly CityLike[] = []
): { id: string; deliveredPrice: number | null } {
  const target = city.trim().toLowerCase();

  for (const [name, id] of Object.entries(config.cityIdByName ?? {})) {
    if (name.trim().toLowerCase() === target) {
      const idStr = String(id).trim();
      const match = catalogue.find((c) => c.id === idStr);
      return { id: idStr, deliveredPrice: match?.deliveredPrice ?? null };
    }
  }
  for (const entry of catalogue) {
    if (entry.name.trim().toLowerCase() === target) {
      return { id: entry.id, deliveredPrice: entry.deliveredPrice ?? null };
    }
  }

  throw new DeliveryConfigError(
    `« ${city} » ne correspond à aucune ville desservie par OzonExpress. ` +
      "Vérifiez l'orthographe de la ville de la commande, ou ajoutez une correspondance " +
      "ville → identifiant dans la configuration du connecteur."
  );
}

/** Just the id — kept for `buildAddParcelForm` and existing callers/tests. */
export function resolveCityId(city: string, config: OzonExpressConfig, catalogue: readonly CityLike[] = []): string {
  return resolveCity(city, config, catalogue).id;
}

/**
 * Normalizes a phone number to the local Moroccan format OzonExpress
 * expects (10 digits starting with 0). `+212 6 12 34 56 78`, `0612...`,
 * and `612...` all collapse to `0612345678`. Returns the digits unchanged
 * if the shape is unrecognized — the carrier can then reject it explicitly
 * rather than this adapter silently mangling a valid international number.
 */
export function normalizeMoroccanPhone(phone: string | null): string {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("212") && digits.length >= 11) return "0" + digits.slice(3);
  if (digits.startsWith("00212") && digits.length >= 13) return "0" + digits.slice(5);
  if (digits.length === 9) return "0" + digits;
  return digits;
}

export function buildAddParcelForm(
  input: CreateShipmentAdapterInput,
  config: OzonExpressConfig,
  catalogue: readonly CityLike[] = []
): Record<string, string> {
  if (input.codAmount !== null && input.codAmount < 0) {
    throw new DeliveryConfigError("Le montant à encaisser (COD) ne peut pas être négatif.");
  }
  const form: Record<string, string> = {
    // Our local shipment id doubles as the custom tracking number so a
    // retried create is idempotent on OzonExpress's side (it rejects a
    // duplicate custom tracking number). See docs/adr/0013 ("Idempotency").
    "tracking-number": input.localShipmentId,
    "parcel-receiver": input.recipientName,
    "parcel-phone": normalizeMoroccanPhone(input.phone),
    "parcel-city": resolveCityId(input.city, config, catalogue),
    "parcel-address": [input.addressLine1, input.addressLine2].filter(Boolean).join(", "),
    // COD amount to collect. `0` is meaningful here (prepaid order — collect
    // nothing), and is NOT the "missing cost" case docs/adr/0012 warns
    // about; that rule is about the carrier's delivery fee, not COD.
    "parcel-price": String(Math.round(input.codAmount ?? 0)),
    // 0 = ramassage (carrier pickup), 1 = stock (already in OZ warehouse).
    "parcel-stock": config.stockMode === "stock" ? "1" : "0",
  };
  const nature = config.defaultParcelNature?.trim();
  if (nature) form["parcel-nature"] = nature;
  if (input.notes?.trim()) form["parcel-note"] = input.notes.trim();
  return form;
}

// ---------------------------------------------------------------------------
// Inbound: add-parcel response → CreateShipmentAdapterResult fields
// ---------------------------------------------------------------------------

export interface ParsedCreateResult {
  externalId: string;
  trackingNumber: string | null;
  cost: number | null;
  rawStatus: string | null;
}

/** Pulls the parcel body out of whichever envelope OzonExpress used (flat,
 * or nested under `ADD-PARCEL.NEW-PARCEL`). */
export function parseAddParcelResponse(raw: unknown): ParsedCreateResult {
  const parsed = ozonExpressAddParcelResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DeliveryMalformedResponseError("Réponse de création de colis OzonExpress invalide.");
  }

  const nested = parsed.data["ADD-PARCEL"]?.["NEW-PARCEL"];
  const bodyParsed = ozonExpressParcelBodySchema.safeParse(nested ?? parsed.data);
  if (!bodyParsed.success) {
    throw new DeliveryMalformedResponseError("Réponse de création de colis OzonExpress invalide.");
  }
  const body = bodyParsed.data;

  const trackingRaw = body["TRACKING-NUMBER"] ?? parsed.data["TRACKING-NUMBER"];
  const tracking = trackingRaw === undefined || trackingRaw === null ? "" : String(trackingRaw).trim();
  if (!tracking) {
    // No id came back — never fabricate one (docs/adr/0012 "Shipment
    // creation"). The caller marks the local shipment ECHEC.
    throw new DeliveryMalformedResponseError(
      "OzonExpress n'a pas renvoyé de numéro de suivi pour ce colis."
    );
  }

  return {
    externalId: tracking,
    trackingNumber: tracking,
    // OzonExpress returns the delivery fee that WILL apply if the parcel is
    // delivered. It is the closest thing to "what the carrier charges for
    // this shipment"; store it, but see docs/adr/0013 for the caveat that
    // the final figure can differ (return / refusal fees).
    cost: parseMoney(body["DELIVERED-PRICE"]),
    rawStatus: body.STATUS?.trim() || null,
  };
}

// ---------------------------------------------------------------------------
// Inbound: tracking response → status
// ---------------------------------------------------------------------------

export interface ParsedTrackingResult {
  rawStatus: string;
  cost: number | null;
}

/**
 * `CHECK_API.MESSAGE` from a credentialed response (e.g. "Valide API Key")
 * — surfaced by the connection test. Returns undefined when the block is
 * absent or not a SUCCESS.
 */
export function readCheckApiMessage(raw: unknown): string | undefined {
  const parsed = ozonExpressTrackingResponseSchema.safeParse(raw);
  const check = parsed.success ? parsed.data.CHECK_API : undefined;
  if (check?.RESULT?.toUpperCase() === "SUCCESS") return check.MESSAGE?.trim() || undefined;
  return undefined;
}

/**
 * Real `tracking` envelope (confirmed live): the current status is
 * `TRACKING.LAST_TRACKING.STATUT`, with the last `TRACKING.HISTORY` entry
 * as a fallback. Older permissive shapes are still probed last. If no
 * status is anywhere, that's malformed (not "unknown").
 */
export function parseTrackingResponse(raw: unknown): ParsedTrackingResult {
  const parsed = ozonExpressTrackingResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DeliveryMalformedResponseError("Réponse de suivi OzonExpress invalide.");
  }

  const t = parsed.data.TRACKING;
  const historyEntries = t?.HISTORY
    ? Array.isArray(t.HISTORY)
      ? t.HISTORY
      : Object.values(t.HISTORY)
    : [];
  const lastHistory = historyEntries.length > 0 ? historyEntries[historyEntries.length - 1] : undefined;

  const status =
    t?.LAST_TRACKING?.STATUT?.trim() ||
    t?.LAST_TRACKING?.STATUS?.trim() ||
    lastHistory?.STATUT?.trim() ||
    lastHistory?.STATUS?.trim() ||
    // legacy fallbacks
    parsed.data.STATUS?.trim() ||
    parsed.data["LAST-TRACKING"]?.STATUT?.trim() ||
    parsed.data["LAST-TRACKING"]?.STATUS?.trim();

  if (!status) {
    throw new DeliveryMalformedResponseError(
      "OzonExpress n'a pas renvoyé de statut lisible pour ce colis."
    );
  }

  const cost = parseMoney(t?.["DELIVERED-PRICE"] ?? parsed.data["DELIVERED-PRICE"]);
  return { rawStatus: status, cost };
}

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

/**
 * OzonExpress raw `STATUT` → local ShipmentStatus.
 *
 * ✅ Confirmed against the live API (2026-09-01): "Nouveau Colis",
 * "Attente De Ramassage", "Ramassé", "Reçu", "Mise en distribution".
 * ⚠️ The delivered / returned / refused / cancelled wording is NOT yet
 * confirmed — the entries for those are a best guess of OzonExpress's
 * likely French phrasing. Anything not in this table is returned as `null`
 * by `mapOzonExpressStatus` and preserved verbatim as
 * `Shipment.providerStatusRaw` — never guessed a local status (docs/adr/0012
 * "Status synchronization", docs/adr/0013).
 *
 * Keys are matched after normalization (lower-case, accent-stripped,
 * trimmed, runs of space / `_` / `-` collapsed to a single space).
 */
const STATUS_TABLE: Record<string, ShipmentStatusValue> = {
  // — registered / awaiting the carrier's pickup (still at the merchant) —
  "nouveau colis": "EN_ATTENTE", // confirmed
  nouveau: "EN_ATTENTE",
  new: "EN_ATTENTE",
  "new parcel": "EN_ATTENTE",
  "en attente": "EN_ATTENTE",
  pending: "EN_ATTENTE",
  "attente de ramassage": "EN_ATTENTE", // confirmed
  "en attente de ramassage": "EN_ATTENTE",

  // — carrier has physically taken the parcel / it is moving —
  ramasse: "EN_TRANSIT", // confirmed ("Ramassé")
  "picked up": "EN_TRANSIT",
  "pris en charge": "EN_TRANSIT",
  recu: "EN_TRANSIT", // confirmed ("Reçu" — at OZ depot)
  "colis recu": "EN_TRANSIT",
  receptionne: "EN_TRANSIT",
  received: "EN_TRANSIT",
  "au depot": "EN_TRANSIT",
  "at warehouse": "EN_TRANSIT",
  expedie: "EN_TRANSIT",
  shipped: "EN_TRANSIT",
  "en transit": "EN_TRANSIT",
  "in transit": "EN_TRANSIT",
  "en cours de livraison": "EN_TRANSIT",
  "out for delivery": "EN_TRANSIT",
  "mise en distribution": "EN_TRANSIT", // confirmed
  distribution: "EN_TRANSIT",

  // — terminal: delivered (wording unconfirmed) —
  livre: "LIVRE",
  delivered: "LIVRE",
  "livraison confirmee": "LIVRE",
  "colis livre": "LIVRE",

  // — failed delivery (wording unconfirmed) —
  "non livre": "ECHEC",
  "echec de livraison": "ECHEC",
  "delivery failed": "ECHEC",
  refuse: "ECHEC",
  refused: "ECHEC",
  "refus client": "ECHEC",
  "colis refuse": "ECHEC",

  // — returned to sender (wording unconfirmed) —
  retourne: "RETOURNE",
  returned: "RETOURNE",
  retour: "RETOURNE",
  "retour a expediteur": "RETOURNE",
  "colis retourne": "RETOURNE",
  "return to sender": "RETOURNE",

  // — cancelled (wording unconfirmed) —
  annule: "ANNULE",
  cancelled: "ANNULE",
  canceled: "ANNULE",
  "colis annule": "ANNULE",
};

function normalizeStatus(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics (é -> e)
    .replace(/[\s_-]+/g, " ")
    .trim();
}

export function mapOzonExpressStatus(raw: string): ShipmentStatusValue | null {
  return STATUS_TABLE[normalizeStatus(raw)] ?? null;
}
