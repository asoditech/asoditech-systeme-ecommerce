import "server-only";

import { DeliveryConfigError, DeliveryMalformedResponseError } from "@/lib/integrations/delivery/errors";
import type { ShipmentStatusValue } from "@/lib/validation/delivery";
import type { CreateShipmentAdapterInput } from "@/lib/integrations/delivery/types";
import { parseMoney } from "./client";
import {
  aramexCalculateRateResponseSchema,
  aramexCreateShipmentsResponseSchema,
  aramexTrackShipmentsResponseSchema,
  type AramexConfig,
} from "./types";

/**
 * Aramex ↔ local-model translation. All carrier-specific vocabulary lives
 * here (docs/adr/0012 "Status synchronization": mapping is adapter-owned).
 *
 * See docs/adr/0028-aramex-integration.md.
 */

const DEFAULT_GOODS_DESCRIPTION = "Marchandise";
const DEFAULT_WEIGHT_KG = 0.5;
const DEFAULT_LABEL_REPORT_ID = 9201;
const DEFAULT_TRACKING_SITE = "https://www.aramex.com";

// ---------------------------------------------------------------------------
// Outbound: local order → CreateShipments payload
// ---------------------------------------------------------------------------

interface ShipperConfig {
  name: string;
  company: string;
  phone: string;
  line1: string;
  city: string;
  countryCode: string;
}

/** Resolves the origin (Shipper) block from config, throwing a typed
 * DeliveryConfigError — BEFORE any external call — when a required piece
 * is missing rather than letting Aramex reject a half-built shipment. */
function resolveShipper(config: AramexConfig, accountCountryCode: string): ShipperConfig {
  const missing: string[] = [];
  if (!config.shipperName) missing.push("nom de l'expéditeur");
  if (!config.shipperPhone) missing.push("téléphone de l'expéditeur");
  if (!config.shipperLine1) missing.push("adresse de l'expéditeur");
  if (!config.shipperCity) missing.push("ville de l'expéditeur");
  if (missing.length > 0) {
    throw new DeliveryConfigError(
      `Configuration Aramex incomplète — renseignez : ${missing.join(", ")} dans la configuration du connecteur.`
    );
  }
  return {
    name: config.shipperName!,
    company: config.shipperCompany?.trim() || config.shipperName!,
    phone: config.shipperPhone!,
    line1: config.shipperLine1!,
    city: config.shipperCity!,
    countryCode: (config.shipperCountryCode ?? accountCountryCode).toUpperCase(),
  };
}

export interface BuildCreateShipmentArgs {
  input: CreateShipmentAdapterInput;
  config: AramexConfig;
  accountNumber: string;
  accountCountryCode: string;
}

/**
 * Builds the `CreateShipments` request body (minus `ClientInfo`, which the
 * client adds). Field names follow Aramex's official PHP sample
 * (`aramex/shipping-services-api-sample-code/createShipmentsPHP.txt`).
 */
export function buildCreateShipmentPayload(args: BuildCreateShipmentArgs): Record<string, unknown> {
  const { input, config, accountNumber, accountCountryCode } = args;

  if (input.codAmount !== null && input.codAmount < 0) {
    throw new DeliveryConfigError("Le montant à encaisser (COD) ne peut pas être négatif.");
  }

  const shipper = resolveShipper(config, accountCountryCode);
  const productGroup = config.productGroup ?? "DOM";
  const productType = config.productType ?? "OND";
  const paymentType = config.paymentType ?? "P";
  const weightKg = config.defaultWeightKg ?? DEFAULT_WEIGHT_KG;
  const goods = config.defaultGoodsDescription?.trim() || input.parcelContents?.trim() || DEFAULT_GOODS_DESCRIPTION;
  const currency = input.currency || "MAD";

  const isCod = input.codAmount !== null && input.codAmount > 0;
  const services = isCod ? "CODS" : "";

  const shipment: Record<string, unknown> = {
    Shipper: {
      Reference1: input.orderNumber,
      AccountNumber: accountNumber,
      PartyAddress: {
        Line1: shipper.line1,
        Line2: "",
        Line3: "",
        City: shipper.city,
        StateOrProvinceCode: "",
        PostCode: "",
        CountryCode: shipper.countryCode,
      },
      Contact: {
        PersonName: shipper.name,
        CompanyName: shipper.company,
        PhoneNumber1: shipper.phone,
        CellPhone: shipper.phone,
        EmailAddress: "",
      },
    },
    Consignee: {
      Reference1: input.orderNumber,
      AccountNumber: "",
      PartyAddress: {
        Line1: input.addressLine1,
        Line2: input.addressLine2 ?? "",
        Line3: "",
        City: input.city,
        StateOrProvinceCode: input.region ?? "",
        PostCode: "",
        CountryCode: (input.country || accountCountryCode).toUpperCase(),
      },
      Contact: {
        PersonName: input.recipientName,
        CompanyName: input.recipientName,
        PhoneNumber1: input.phone ?? "",
        CellPhone: input.phone ?? "",
        EmailAddress: "",
      },
    },
    Reference1: input.orderNumber,
    ForeignHAWB: input.localShipmentId,
    TransportType: 0,
    ShippingDateTime: aramexDate(new Date()),
    DueDate: aramexDate(new Date()),
    PickupLocation: "Reception",
    Comments: input.notes?.trim() || "",
    Details: {
      Dimensions: null,
      ActualWeight: { Value: weightKg, Unit: "Kg" },
      ProductGroup: productGroup,
      ProductType: productType,
      PaymentType: paymentType,
      PaymentOptions: "",
      Services: services,
      NumberOfPieces: 1,
      DescriptionOfGoods: goods,
      GoodsOriginCountry: shipper.countryCode,
      CashOnDeliveryAmount: isCod
        ? { Value: round2(input.codAmount as number), CurrencyCode: currency }
        : { Value: 0, CurrencyCode: currency },
      InsuranceAmount: { Value: 0, CurrencyCode: currency },
      CollectAmount: { Value: 0, CurrencyCode: currency },
      CashAdditionalAmount: { Value: 0, CurrencyCode: currency },
      CustomsValueAmount: { Value: 0, CurrencyCode: currency },
      Items: [],
    },
  };

  return {
    Shipments: [shipment],
    Transaction: { Reference1: input.orderNumber, Reference2: input.localShipmentId },
    LabelInfo: {
      ReportID: config.labelReportId ?? DEFAULT_LABEL_REPORT_ID,
      ReportType: config.labelReportType ?? "URL",
    },
  };
}

/** Aramex's JSON gateway accepts `/Date(ms)/` for date fields. */
function aramexDate(d: Date): string {
  return `/Date(${d.getTime()})/`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Inbound: CreateShipments response → CreateShipmentAdapterResult fields
// ---------------------------------------------------------------------------

export interface ParsedCreateResult {
  externalId: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  rawStatus: string | null;
}

export function parseCreateShipmentResponse(raw: unknown, config: AramexConfig): ParsedCreateResult {
  const parsed = aramexCreateShipmentsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DeliveryMalformedResponseError("Réponse de création d'envoi Aramex invalide.");
  }

  const shipment = parsed.data.Shipments?.[0];
  if (!shipment) {
    throw new DeliveryMalformedResponseError("Aramex n'a renvoyé aucun envoi pour cette demande.");
  }
  if (shipment.HasErrors === true) {
    // Per-shipment error even though the envelope's HasErrors was false.
    const messages = (shipment.Notifications ?? [])
      .map((n) => n.Message?.trim())
      .filter((m): m is string => Boolean(m))
      .join(" · ");
    throw new DeliveryMalformedResponseError(
      messages ? `Aramex a rejeté cet envoi : ${messages}` : "Aramex a rejeté cet envoi."
    );
  }

  const idRaw = shipment.ID ?? shipment.ShipmentNumber;
  const id = idRaw === undefined || idRaw === null ? "" : String(idRaw).trim();
  if (!id) {
    throw new DeliveryMalformedResponseError("Aramex n'a pas renvoyé de numéro d'envoi (AWB).");
  }

  const labelUrl = shipment.ShipmentLabel?.LabelURL?.trim() || null;

  return {
    externalId: id,
    trackingNumber: id,
    trackingUrl: buildTrackingUrl(id, config),
    // The label URL isn't a status; kept only via trackingUrl above. Aramex
    // returns no per-shipment cost on CreateShipments.
    rawStatus: labelUrl ? "Shipment created" : "Shipment created",
  };
}

/** Public Aramex tracking page for a waybill. `config.trackingSiteBaseUrl`
 * is already `https:`-validated by the schema. */
export function buildTrackingUrl(waybill: string, config: AramexConfig): string {
  const base = (config.trackingSiteBaseUrl ?? DEFAULT_TRACKING_SITE).replace(/\/+$/, "");
  return `${base}/track/results?mode=0&ShipmentNumber=${encodeURIComponent(waybill)}`;
}

// ---------------------------------------------------------------------------
// Inbound: TrackShipments response → status
// ---------------------------------------------------------------------------

export interface ParsedTrackingResult {
  rawStatus: string;
  trackingUrl: string | null;
}

export function parseTrackingResponse(raw: unknown, waybill: string, config: AramexConfig): ParsedTrackingResult {
  const parsed = aramexTrackShipmentsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DeliveryMalformedResponseError("Réponse de suivi Aramex invalide.");
  }

  if ((parsed.data.NonExistingWaybills ?? []).map(String).includes(String(waybill))) {
    throw new DeliveryMalformedResponseError("Aramex ne connaît pas ce numéro d'envoi (AWB).");
  }

  const results = parsed.data.TrackingResults;
  let updates: { UpdateDescription?: string; UpdateCode?: string | number; UpdateDateTime?: string }[] = [];

  if (Array.isArray(results)) {
    const pair =
      results.find((p) => String(p.Key ?? "") === String(waybill)) ?? results[0];
    const value = pair?.Value;
    updates = value ? (Array.isArray(value) ? value : [value]) : [];
  } else if (results && typeof results === "object") {
    const value = (results as Record<string, unknown>)[String(waybill)] ?? Object.values(results)[0];
    updates = Array.isArray(value) ? value : value ? [value as (typeof updates)[number]] : [];
  }

  if (updates.length === 0) {
    throw new DeliveryMalformedResponseError("Aramex n'a renvoyé aucune mise à jour pour cet envoi.");
  }

  // Aramex returns updates oldest-first; the last is the current state.
  const last = updates[updates.length - 1];
  const status = last.UpdateDescription?.trim() || (last.UpdateCode ? String(last.UpdateCode) : "");
  if (!status) {
    throw new DeliveryMalformedResponseError("Aramex n'a pas renvoyé de statut lisible pour cet envoi.");
  }

  return { rawStatus: status, trackingUrl: buildTrackingUrl(waybill, config) };
}

// ---------------------------------------------------------------------------
// TrackShipments response → rich detail (« Suivi » module, docs/adr/0033)
// ---------------------------------------------------------------------------

/** Aramex JSON dates are `/Date(1723...)/` (ms), sometimes a plain ISO
 * string. → ISO 8601, or null. */
function aramexDateToIso(raw: string | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  const m = s.match(/\/Date\((-?\d+)([+-]\d+)?\)\//);
  if (m) {
    const d = new Date(Number(m[1]));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The full normalized tracking detail from an Aramex `TrackShipments`
 * response. Aramex's per-waybill `Value` is a list of updates
 * `{UpdateCode, UpdateDescription, UpdateDateTime, UpdateLocation,
 * Comments}` (oldest-first). It carries a location string but no courier —
 * courier comes back `null`, never guessed. Same malformed-response
 * errors as `parseTrackingResponse`.
 */
export function parseTrackingDetail(
  raw: unknown,
  waybill: string,
  config: AramexConfig
): {
  rawStatus: string;
  events: {
    rawStatus: string;
    label: string | null;
    description: string | null;
    location: string | null;
    timestamp: string | null;
  }[];
  courier: { name: string | null; phone: string | null } | null;
  location: { city: string | null; area: string | null } | null;
  lastUpdateAt: string | null;
} {
  const base = parseTrackingResponse(raw, waybill, config); // reuse validation + status
  const parsed = aramexTrackShipmentsResponseSchema.safeParse(raw);
  const results = parsed.success ? parsed.data.TrackingResults : undefined;

  let updates: {
    UpdateCode?: string | number;
    UpdateDescription?: string;
    UpdateDateTime?: string;
    UpdateLocation?: string;
    Comments?: string;
  }[] = [];
  if (Array.isArray(results)) {
    const pair = results.find((p) => String(p.Key ?? "") === String(waybill)) ?? results[0];
    const value = pair?.Value;
    updates = value ? (Array.isArray(value) ? value : [value]) : [];
  } else if (results && typeof results === "object") {
    const value = (results as Record<string, unknown>)[String(waybill)] ?? Object.values(results)[0];
    updates = Array.isArray(value) ? value : value ? [value as (typeof updates)[number]] : [];
  }

  const events = updates
    .map((u) => {
      const desc = u.UpdateDescription?.trim() || (u.UpdateCode ? String(u.UpdateCode) : "");
      if (!desc) return null;
      const comment = u.Comments?.trim() || null;
      return {
        rawStatus: desc,
        label: comment && comment.toLowerCase() !== desc.toLowerCase() ? comment : null,
        description: comment,
        location: u.UpdateLocation?.trim() || null,
        timestamp: aramexDateToIso(u.UpdateDateTime),
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  const lastCity = events.length > 0 ? events[events.length - 1].location : null;

  return {
    rawStatus: base.rawStatus,
    events,
    courier: null,
    location: lastCity ? { city: lastCity, area: null } : null,
    lastUpdateAt: events.length > 0 ? events[events.length - 1].timestamp : null,
  };
}

// ---------------------------------------------------------------------------
// CalculateRate — FETCH_COST
// ---------------------------------------------------------------------------

export function buildCalculateRatePayload(args: {
  input: CreateShipmentAdapterInput;
  config: AramexConfig;
  accountCountryCode: string;
}): Record<string, unknown> {
  const { input, config, accountCountryCode } = args;
  const shipper = resolveShipper(config, accountCountryCode);
  const weightKg = config.defaultWeightKg ?? DEFAULT_WEIGHT_KG;
  const currency = input.currency || "MAD";
  return {
    OriginAddress: {
      Line1: shipper.line1,
      City: shipper.city,
      CountryCode: shipper.countryCode,
    },
    DestinationAddress: {
      Line1: input.addressLine1,
      City: input.city,
      CountryCode: (input.country || accountCountryCode).toUpperCase(),
    },
    ShipmentDetails: {
      ActualWeight: { Value: weightKg, Unit: "Kg" },
      ProductGroup: config.productGroup ?? "DOM",
      ProductType: config.productType ?? "OND",
      PaymentType: config.paymentType ?? "P",
      NumberOfPieces: 1,
      DescriptionOfGoods: config.defaultGoodsDescription?.trim() || "Marchandise",
      GoodsOriginCountry: shipper.countryCode,
      CashOnDeliveryAmount: { Value: 0, CurrencyCode: currency },
      InsuranceAmount: { Value: 0, CurrencyCode: currency },
      CollectAmount: { Value: 0, CurrencyCode: currency },
      CustomsValueAmount: { Value: 0, CurrencyCode: currency },
    },
    PreferredCurrencyCode: currency,
    Transaction: { Reference1: input.orderNumber },
  };
}

export function parseCalculateRateResponse(raw: unknown): number | null {
  const parsed = aramexCalculateRateResponseSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parseMoney(parsed.data.TotalAmount?.Value);
}

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

/**
 * Aramex tracking `UpdateDescription` / `UpdateCode` → local ShipmentStatus.
 *
 * ⚠️ NOT yet confirmed against a real Aramex account. Descriptions are
 * matched after normalization (lower-case, accent-stripped, whitespace
 * collapsed); a handful of well-known `SHxxx` update codes are matched
 * directly. Anything not in these tables returns `null` from
 * `mapAramexStatus` and is preserved verbatim as `Shipment.providerStatusRaw`
 * — never guessed (docs/adr/0012 "Status synchronization").
 */
const DESCRIPTION_TABLE: Record<string, ShipmentStatusValue> = {
  "shipment created": "EN_ATTENTE",
  "shipment information received": "EN_ATTENTE",
  "record created": "EN_ATTENTE",
  "picked up from customer": "EN_TRANSIT",
  "picked up": "EN_TRANSIT",
  "shipment picked up": "EN_TRANSIT",
  "in transit": "EN_TRANSIT",
  "received at origin facility": "EN_TRANSIT",
  "departed from origin": "EN_TRANSIT",
  "arrived at destination": "EN_TRANSIT",
  "received at destination": "EN_TRANSIT",
  "held in operations facility": "EN_TRANSIT",
  "out for delivery": "EN_TRANSIT",
  "with delivery courier": "EN_TRANSIT",
  delivered: "LIVRE",
  "shipment delivered": "LIVRE",
  "proof of delivery": "LIVRE",
  "delivery failed": "ECHEC",
  "failed delivery attempt": "ECHEC",
  "unsuccessful delivery attempt": "ECHEC",
  "customer refused delivery": "ECHEC",
  "refused by consignee": "ECHEC",
  "bad address": "ECHEC",
  "returned to shipper": "RETOURNE",
  "shipment returned to shipper": "RETOURNE",
  "returned to origin": "RETOURNE",
  "shipment cancelled": "ANNULE",
  cancelled: "ANNULE",
};

/** Well-known Aramex update codes. */
const CODE_TABLE: Record<string, ShipmentStatusValue> = {
  SH001: "EN_ATTENTE",
  SH014: "EN_TRANSIT",
  SH005: "EN_TRANSIT",
  SH006: "LIVRE",
  SH234: "ECHEC",
  SH029: "ECHEC",
  SH033: "RETOURNE",
};

function normalize(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[\s_-]+/g, " ")
    .trim();
}

export function mapAramexStatus(raw: string): ShipmentStatusValue | null {
  const trimmed = raw.trim();
  const codeMatch = CODE_TABLE[trimmed.toUpperCase()];
  if (codeMatch) return codeMatch;
  return DESCRIPTION_TABLE[normalize(trimmed)] ?? null;
}
