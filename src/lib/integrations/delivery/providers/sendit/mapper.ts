import "server-only";

import {
  DeliveryAuthError,
  DeliveryConfigError,
  DeliveryMalformedResponseError,
} from "@/lib/integrations/delivery/errors";
import type {
  AdapterTrackingEvent,
  CreateShipmentAdapterInput,
  DeliveryCity,
} from "@/lib/integrations/delivery/types";
import { isAllowedCarrierUrl, SENDIT_LABEL_HOSTS } from "@/lib/integrations/delivery/carrier-hosts";
import { errorForSenditEnvelope } from "./errors";
import { composeSenditRawStatus, senditStatusLabel } from "./status";
import {
  senditAuditSchema,
  senditDeliveryDetailSchema,
  senditDistrictSchema,
  senditEnvelopeSchema,
  senditLabelsDataSchema,
  senditLoginDataSchema,
  senditPaginationSchema,
  senditPickupCitySchema,
  senditStatusCatalogueSchema,
  type SenditConfig,
  type SenditCreateDeliveryBody,
} from "./types";

/**
 * Sendit ↔ local-model translation — PURE (no network). Built from the
 * official spec + Swagger export; see ./index.ts for the open questions.
 */

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function parseMoney(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function idToString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

/**
 * A label link from a Sendit response, kept only when it is `https:` AND on
 * Sendit's own host (`app.sendit.ma` — the spec's `labelUrl` / `fileUrl`
 * examples are `https://app.sendit.ma/signed-files/…`). Anything else is
 * dropped: the operator's browser opens this link, so a response can never
 * send them to an arbitrary site.
 */
function senditLabelUrlOrNull(value: unknown): string | null {
  if (!isAllowedCarrierUrl(value, SENDIT_LABEL_HOSTS)) return null;
  return new URL((value as string).trim()).toString();
}

function nonEmpty(value: string | null | undefined): string | null {
  const t = typeof value === "string" ? value.trim() : "";
  return t === "" ? null : t;
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export interface SenditPagination {
  total: number | null;
  perPage: number | null;
  currentPage: number | null;
  lastPage: number | null;
  hasNextPage: boolean;
}

/**
 * Validates the documented `{ success, message, data }` envelope and returns
 * `data`. `success: false` → typed error with a sanitized message (secrets
 * passed in `redact` are masked). Unrecognizable body → malformed.
 */
export function assertEnvelopeSuccess(raw: unknown, redact: readonly (string | null | undefined)[] = []): unknown {
  const parsed = senditEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DeliveryMalformedResponseError("Réponse Sendit illisible (enveloppe inattendue).");
  }
  if (!parsed.data.success) throw errorForSenditEnvelope(parsed.data.message, redact);
  return parsed.data.data;
}

function parsePagination(raw: unknown): SenditPagination {
  const p = senditPaginationSchema.safeParse(raw);
  const d = p.success ? p.data : {};
  return {
    total: parseMoney(d.total),
    perPage: parseMoney(d.per_page),
    currentPage: parseMoney(d.current_page),
    lastPage: parseMoney(d.last_page),
    hasNextPage: typeof d.next_page_url === "string" && d.next_page_url.trim() !== "",
  };
}

// ---------------------------------------------------------------------------
// POST /login
// ---------------------------------------------------------------------------

/** Returns the bearer-ish token (header/scheme UNDOCUMENTED). The token is
 * never logged and never included in any error message. */
export function parseLoginResponse(raw: unknown): string {
  const env = senditEnvelopeSchema.safeParse(raw);
  if (env.success && env.data.success === false) {
    throw new DeliveryAuthError("Authentification refusée par Sendit — vérifiez la clé publique et la clé secrète.");
  }
  const data = assertEnvelopeSuccess(raw);
  const parsed = senditLoginDataSchema.safeParse(data);
  const token = parsed.success ? nonEmpty(parsed.data.token) : null;
  if (!token) throw new DeliveryMalformedResponseError("Réponse de connexion Sendit sans jeton.");
  return token;
}

// ---------------------------------------------------------------------------
// POST /deliveries — body
// ---------------------------------------------------------------------------

export interface SenditCreateOptions {
  /** Documented as « Montant total de colis ». REQUIRED from the caller —
   * this module never derives it (prepaid semantics are undocumented). */
  amount: number;
  /** Exchange parcel code. When set, `option_exchange: 1` +
   * `delivery_exchange_id` are sent; otherwise both are omitted. */
  deliveryExchangeId?: string | null;
}

function toPositiveInt(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return n > 0 ? n : null;
  }
  return null;
}

/**
 * Builds the POST /deliveries body using ONLY documented fields.
 * - `phone` is passed through trimmed (documented example 06XXXXXXXX; the
 *   accepted formats are undocumented → open question).
 * - `products_from_stock` is always 0, so `packaging_id` (stock-only) is
 *   never sent; `products` = parcelContents or "" per the doc.
 * - `pickup_district_id` / `allow_open` / `allow_try` are omitted when not
 *   configured (defaults undocumented).
 */
export function buildCreateDeliveryBody(
  input: CreateShipmentAdapterInput,
  cfg: SenditConfig,
  districtId: number | string,
  options: SenditCreateOptions
): SenditCreateDeliveryBody {
  const district = toPositiveInt(districtId);
  if (district === null) {
    throw new DeliveryConfigError("Identifiant de ville Sendit invalide — vérifiez la correspondance de villes.");
  }
  if (typeof options.amount !== "number" || !Number.isFinite(options.amount) || options.amount < 0) {
    throw new DeliveryConfigError("Le montant du colis Sendit doit être un nombre positif ou nul.");
  }

  const address = [input.addressLine1, input.addressLine2]
    .map((l) => nonEmpty(l))
    .filter((l): l is string => l !== null)
    .join(", ");

  const body: SenditCreateDeliveryBody = {
    district_id: district,
    name: input.recipientName.trim(),
    amount: options.amount,
    address,
    phone: (input.phone ?? "").trim(),
    comment: nonEmpty(input.notes),
    reference: nonEmpty(input.orderNumber),
    products_from_stock: 0,
    products: nonEmpty(input.parcelContents ?? null) ?? "",
  };
  if (cfg.pickupDistrictId !== undefined) body.pickup_district_id = cfg.pickupDistrictId;
  if (cfg.allowOpen !== undefined) body.allow_open = cfg.allowOpen;
  if (cfg.allowTry !== undefined) body.allow_try = cfg.allowTry;

  const exchange = nonEmpty(options.deliveryExchangeId ?? null);
  if (exchange) {
    body.option_exchange = 1;
    body.delivery_exchange_id = exchange;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Delivery detail (create / GET / PUT response)
// ---------------------------------------------------------------------------

export interface SenditDeliveryDetail {
  code: string;
  status: string | null;
  statusReturn: string | null;
  fee: number | null;
  /** Signed, valid ~24h per doc — use as is, never persist as permanent. */
  labelUrl: string | null;
  /** Verbatim "YYYY-MM-DD HH:MM:SS" — timezone undocumented, not converted. */
  lastActionAt: string | null;
}

export function parseDeliveryDetail(raw: unknown): SenditDeliveryDetail {
  const data = assertEnvelopeSuccess(raw);
  const parsed = senditDeliveryDetailSchema.safeParse(data);
  if (!parsed.success) {
    throw new DeliveryMalformedResponseError("Réponse Sendit illisible (détails du colis).");
  }
  const code = idToString(parsed.data.code);
  if (!code) throw new DeliveryMalformedResponseError("Réponse Sendit sans code de colis.");
  return {
    code,
    status: nonEmpty(parsed.data.status),
    statusReturn: nonEmpty(parsed.data.status_return),
    fee: parseMoney(parsed.data.fee),
    labelUrl: senditLabelUrlOrNull(parsed.data.labelUrl),
    lastActionAt: nonEmpty(parsed.data.last_action_at),
  };
}

/**
 * Tracking view of the same GET /deliveries/{code} body: the detail plus the
 * `audits` history turned into events. Each audit whose `data.status` is set
 * becomes one event (consecutive duplicates dropped — audits log every field
 * change). Kept in the order Sendit returns them (ordering is undocumented).
 * `created_at` is a pre-formatted French date with no timezone, so it goes
 * into `description` verbatim and `timestamp` stays null — never invented.
 */
export function parseDeliveryTracking(raw: unknown): {
  detail: SenditDeliveryDetail;
  events: AdapterTrackingEvent[];
} {
  const detail = parseDeliveryDetail(raw);
  const data = (raw as { data?: { audits?: unknown } } | null)?.data;
  const audits = Array.isArray(data?.audits) ? data.audits : [];
  const events: AdapterTrackingEvent[] = [];
  let previous: string | null = null;
  for (const entry of audits) {
    const p = senditAuditSchema.safeParse(entry);
    if (!p.success) continue;
    const status = nonEmpty(p.data.data?.status);
    if (!status) continue;
    const rawStatus = composeSenditRawStatus(status, nonEmpty(p.data.data?.status_return));
    if (rawStatus === previous) continue;
    previous = rawStatus;
    events.push({
      rawStatus,
      label: senditStatusLabel(status),
      description: nonEmpty(p.data.created_at),
      location: null,
      timestamp: null,
    });
  }
  return { detail, events };
}

// ---------------------------------------------------------------------------
// Districts / pickup cities
// ---------------------------------------------------------------------------

export interface SenditDistrict {
  id: string;
  name: string | null;
  ville: string | null;
  arabicName: string | null;
  price: number | null;
  delais: string | null;
}

export interface SenditPickupCity {
  id: string;
  name: string;
  arabicName: string | null;
}

function dataArray(data: unknown): unknown[] {
  if (!Array.isArray(data)) {
    throw new DeliveryMalformedResponseError("Réponse Sendit illisible (liste attendue).");
  }
  return data;
}

/** GET /districts — entries without an id or any name are dropped. */
export function parseDistricts(raw: unknown): { districts: SenditDistrict[]; pagination: SenditPagination } {
  const list = dataArray(assertEnvelopeSuccess(raw));
  const districts: SenditDistrict[] = [];
  for (const entry of list) {
    const p = senditDistrictSchema.safeParse(entry);
    if (!p.success) continue;
    const id = idToString(p.data.id);
    const name = nonEmpty(p.data.name);
    const ville = nonEmpty(p.data.ville);
    if (!id || (!name && !ville)) continue;
    districts.push({
      id,
      name,
      ville,
      arabicName: nonEmpty(p.data.arabic_name),
      price: parseMoney(p.data.price),
      delais: p.data.delais === null || p.data.delais === undefined ? null : String(p.data.delais),
    });
  }
  return { districts, pagination: parsePagination(raw) };
}

/** GET /districts/pickup-cities. */
export function parsePickupCities(raw: unknown): SenditPickupCity[] {
  const list = dataArray(assertEnvelopeSuccess(raw));
  const out: SenditPickupCity[] = [];
  for (const entry of list) {
    const p = senditPickupCitySchema.safeParse(entry);
    if (!p.success) continue;
    const id = idToString(p.data.id);
    const name = nonEmpty(p.data.name);
    if (!id || !name) continue;
    out.push({ id, name, arabicName: nonEmpty(p.data.arabic_name) });
  }
  return out;
}

/** Generic catalogue view. `name` prefers `name`, falls back to `ville`;
 * the semantic difference between the two is an open question. */
export function toDeliveryCities(districts: readonly SenditDistrict[]): DeliveryCity[] {
  return districts.map((d) => ({
    id: d.id,
    name: (d.name ?? d.ville) as string,
    region: d.ville && d.ville !== d.name ? d.ville : null,
  }));
}

// ---------------------------------------------------------------------------
// Labels / status catalogue
// ---------------------------------------------------------------------------

/** POST /deliveries/getlabels → signed `fileUrl` (https only). */
export function parseLabelsResponse(raw: unknown): string {
  const data = assertEnvelopeSuccess(raw);
  const p = senditLabelsDataSchema.safeParse(data);
  const url = p.success ? senditLabelUrlOrNull(p.data.fileUrl) : null;
  if (!url) throw new DeliveryMalformedResponseError("Réponse Sendit sans lien d'étiquettes valide (HTTPS sur app.sendit.ma requis).");
  return url;
}

/** GET /all-status-deliveries → `{ CODE: label }`. */
export function parseStatusCatalogue(raw: unknown): Record<string, string> {
  const p = senditStatusCatalogueSchema.safeParse(assertEnvelopeSuccess(raw));
  if (!p.success) throw new DeliveryMalformedResponseError("Réponse Sendit illisible (catalogue de statuts).");
  return p.data;
}
