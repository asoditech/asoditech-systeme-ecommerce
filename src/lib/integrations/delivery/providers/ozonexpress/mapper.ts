import "server-only";

import { z } from "zod";
import { DeliveryConfigError, DeliveryMalformedResponseError } from "@/lib/integrations/delivery/errors";
import type { ShipmentStatusValue } from "@/lib/validation/delivery";
import { parseMoney } from "./client";
import {
  ozonExpressAddParcelResponseSchema,
  ozonExpressParcelBodySchema,
  ozonExpressTrackingResponseSchema,
  type OzonExpressConfig,
} from "./types";
import type { CreateShipmentAdapterInput } from "@/lib/integrations/delivery/types";

/**
 * OzonExpress ↔ local-model translation. All carrier-specific vocabulary
 * lives here (docs/adr/0012 "Status synchronization": mapping is
 * adapter-owned, never a shared guess table).
 *
 * ⚠️ UNVERIFIED. See docs/adr/0013-ozonexpress-integration.md.
 */

// ---------------------------------------------------------------------------
// Outbound: local order → add-parcel form fields
// ---------------------------------------------------------------------------

/** Resolves the recipient city to an OzonExpress numeric city id using the
 * operator-supplied `cityIdByName` map. Throws a typed config error (before
 * any network call) rather than guessing an id — see docs/adr/0013
 * ("City identifiers"). */
export function resolveCityId(city: string, config: OzonExpressConfig): string {
  const map = config.cityIdByName ?? {};
  const target = city.trim().toLowerCase();
  for (const [name, id] of Object.entries(map)) {
    if (name.trim().toLowerCase() === target) return String(id).trim();
  }
  throw new DeliveryConfigError(
    `Aucun identifiant de ville OzonExpress n'est configuré pour « ${city} ». ` +
      "Ajoutez la correspondance ville → identifiant dans la configuration du connecteur."
  );
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
  config: OzonExpressConfig
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
    "parcel-city": resolveCityId(input.city, config),
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

const nestedTrackingStatusSchema = z
  .object({
    STATUT: z.string().optional(),
    STATUS: z.string().optional(),
    "LAST-TRACKING": z.object({ STATUT: z.string().optional(), STATUS: z.string().optional() }).passthrough().optional(),
    "TRACKING-HISTORY": z
      .array(z.object({ STATUT: z.string().optional(), STATUS: z.string().optional(), DATE: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough();

/** OzonExpress puts the current status under a different key depending on
 * the response variant. Probe the known locations; if none is present the
 * status genuinely could not be read (malformed) rather than "unknown". */
export function parseTrackingResponse(raw: unknown): ParsedTrackingResult {
  const parsed = ozonExpressTrackingResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DeliveryMalformedResponseError("Réponse de suivi OzonExpress invalide.");
  }

  let status: string | undefined =
    parsed.data.STATUS?.trim() ||
    parsed.data["LAST-TRACKING"]?.STATUT?.trim() ||
    parsed.data["LAST-TRACKING"]?.STATUS?.trim();

  if (!status && parsed.data.TRACKING !== undefined) {
    const nested = nestedTrackingStatusSchema.safeParse(parsed.data.TRACKING);
    if (nested.success) {
      const history = nested.data["TRACKING-HISTORY"];
      const latest = history && history.length > 0 ? history[history.length - 1] : undefined;
      status =
        nested.data.STATUT?.trim() ||
        nested.data.STATUS?.trim() ||
        nested.data["LAST-TRACKING"]?.STATUT?.trim() ||
        nested.data["LAST-TRACKING"]?.STATUS?.trim() ||
        latest?.STATUT?.trim() ||
        latest?.STATUS?.trim();
    }
  }

  if (!status) {
    throw new DeliveryMalformedResponseError(
      "OzonExpress n'a pas renvoyé de statut lisible pour ce colis."
    );
  }

  return { rawStatus: status, cost: parseMoney(parsed.data["DELIVERED-PRICE"]) };
}

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

/**
 * OzonExpress raw status → local ShipmentStatus.
 *
 * ⚠️ UNVERIFIED and deliberately CONSERVATIVE. OzonExpress does not publish
 * its status vocabulary; the entries below are the French/English strings
 * that appear consistently across the community integrations this adapter
 * was reconstructed from. Anything not in this table is returned as `null`
 * by `mapOzonExpressStatus` and preserved verbatim as
 * `Shipment.providerStatusRaw` — never guessed (docs/adr/0012 "Status
 * synchronization", docs/adr/0013 "Status mapping").
 *
 * Keys are matched after normalization (lower-case, trimmed, runs of
 * space / `_` / `-` collapsed to a single space).
 */
const STATUS_TABLE: Record<string, ShipmentStatusValue> = {
  // — awaiting pickup / at hub, not yet moving to the customer —
  "nouveau colis": "EN_ATTENTE",
  nouveau: "EN_ATTENTE",
  new: "EN_ATTENTE",
  "new parcel": "EN_ATTENTE",
  "en attente": "EN_ATTENTE",
  pending: "EN_ATTENTE",
  "colis recu": "EN_ATTENTE",
  receptionne: "EN_ATTENTE",
  received: "EN_ATTENTE",
  "au depot": "EN_ATTENTE",
  "at warehouse": "EN_ATTENTE",
  "pris en charge": "EN_ATTENTE",
  "picked up": "EN_ATTENTE",
  ramasse: "EN_ATTENTE",

  // — moving toward / with the customer —
  expedie: "EN_TRANSIT",
  shipped: "EN_TRANSIT",
  "en transit": "EN_TRANSIT",
  "in transit": "EN_TRANSIT",
  "en cours de livraison": "EN_TRANSIT",
  "out for delivery": "EN_TRANSIT",
  "mise en distribution": "EN_TRANSIT",
  distribution: "EN_TRANSIT",

  // — terminal: delivered —
  livre: "LIVRE",
  delivered: "LIVRE",
  "livraison confirmee": "LIVRE",

  // — failed delivery —
  "non livre": "ECHEC",
  "echec de livraison": "ECHEC",
  "delivery failed": "ECHEC",
  refuse: "ECHEC",
  refused: "ECHEC",
  "refus client": "ECHEC",

  // — returned to sender —
  retourne: "RETOURNE",
  returned: "RETOURNE",
  retour: "RETOURNE",
  "retour a expediteur": "RETOURNE",
  "return to sender": "RETOURNE",

  // — cancelled —
  annule: "ANNULE",
  cancelled: "ANNULE",
  canceled: "ANNULE",
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
