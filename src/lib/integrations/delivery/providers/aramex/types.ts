import "server-only";

import { z } from "zod";

/**
 * Aramex adapter — credential / config shapes and response schemas.
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  ENDPOINTS FROM OFFICIAL ARAMEX DOCS · REQUEST/RESPONSE NOT YET LIVE-TESTED
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Aramex ships a SOAP API (the WSDLs in the owner-provided `aramex/`
 * bundle date from 2012) but also exposes the SAME operations as JSON over
 * HTTPS POST, which is what this adapter uses:
 *
 *   POST {shippingBaseUrl}/Shipping/Service_1_0.svc/json/CreateShipments
 *   POST {trackingBaseUrl}/Tracking/Service_1_0.svc/json/TrackShipments
 *   POST {rateBaseUrl}/RateCalculator/Service_1_0.svc/json/CalculateRate
 *
 * Every request body carries a `ClientInfo` block (the credentials) plus a
 * `Transaction` block (free-text references echoed back). Aramex signals
 * failure with an HTTP 200 body of `{ "HasErrors": true, "Notifications":
 * [ { "Code": "...", "Message": "..." } ] }` — checked by the client.
 *
 * ⚠️ NOT yet run against a real Aramex account. Request field names come
 * from the official sample code (`aramex/shipping-services-api-sample-code/
 * createShipmentsPHP.txt`) and Aramex's developer guide; response parsing
 * is defensive, same posture as the OzonExpress adapter before its live
 * verification. See docs/adr/0028-aramex-integration.md.
 */

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * The Aramex `ClientInfo` values, issued by Aramex when a business account
 * is enabled for API access ("Aramex API tools" / integration request).
 * All six are required for every call. Stored AES-256-GCM encrypted on
 * `ShippingProvider.credentialsEncrypted`, never returned to the browser.
 *
 * `accountEntity` is the 3-letter origin branch code (e.g. "AMM", "DXB",
 * "CMN" for Casablanca). `accountCountryCode` is the ISO-2 country of the
 * account (e.g. "MA"). `accountPin` is the numeric API PIN, distinct from
 * the portal password.
 */
export const aramexCredentialsSchema = z.object({
  userName: z.string().trim().min(1, "Le nom d'utilisateur Aramex est requis."),
  password: z.string().min(1, "Le mot de passe API Aramex est requis."),
  accountNumber: z.string().trim().min(1, "Le numéro de compte Aramex est requis."),
  accountPin: z.string().trim().min(1, "Le code PIN du compte Aramex est requis."),
  accountEntity: z.string().trim().min(1, "L'entité (agence d'origine) Aramex est requise."),
  accountCountryCode: z
    .string()
    .trim()
    .min(2, "Le code pays du compte Aramex est requis (ISO-2, ex. MA).")
    .max(2, "Le code pays du compte Aramex doit être au format ISO-2 (ex. MA)."),
});
export type AramexCredentials = z.infer<typeof aramexCredentialsSchema>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Non-secret per-instance configuration.
 *
 * The shipper block: Aramex's `CreateShipments` needs a full origin
 * (`Shipper`) address + contact on every shipment. These come from the
 * connector config once, not from each order.
 *   `shipperName`         — contact person / brand at pickup
 *   `shipperCompany`      — company name on the label (defaults to shipperName)
 *   `shipperPhone`        — pickup contact number
 *   `shipperLine1`        — pickup street address
 *   `shipperCity`         — pickup city
 *   `shipperCountryCode`  — pickup country ISO-2 (defaults to accountCountryCode)
 *
 * The product block: Aramex classifies every shipment.
 *   `productGroup`  — "DOM" (domestic) or "EXP" (express/international).
 *                     Defaults to "DOM" — the common case for a Moroccan
 *                     merchant shipping inside Morocco.
 *   `productType`   — e.g. "OND" (domestic on-demand / COD), "CDS", "PDX",
 *                     "PPX". Defaults to "OND".
 *   `paymentType`   — "P" prepaid (shipper pays), "C" collect, "3" third
 *                     party. Defaults to "P".
 *
 * `labelReportId` — Aramex label report id used when asking for a label
 *   URL back on `CreateShipments` (`LabelInfo.ReportID`). 9201 is the
 *   standard label; left configurable. `labelReportType` is "URL" or "RPT".
 *
 * `source` — Aramex `ClientInfo.Source`, a small integer identifying the
 *   calling channel. 24 is the value Aramex hands most JSON integrators;
 *   overridable if Aramex assigns a different one.
 *
 * `shippingBaseUrl` / `trackingBaseUrl` / `rateBaseUrl` — override only,
 *   for pointing at Aramex's test hosts. Always re-validated for SSRF
 *   before every request; must be `https:`.
 *
 * `requestTimeoutMs` — per-request timeout override (1–60 s).
 */
export const aramexConfigSchema = z.object({
  shipperName: z.string().trim().min(1).max(120).optional(),
  shipperCompany: z.string().trim().min(1).max(120).optional(),
  shipperPhone: z.string().trim().min(1).max(40).optional(),
  shipperLine1: z.string().trim().min(1).max(200).optional(),
  shipperCity: z.string().trim().min(1).max(100).optional(),
  shipperCountryCode: z.string().trim().length(2).optional(),

  productGroup: z.enum(["DOM", "EXP"]).optional(),
  productType: z.string().trim().min(2).max(10).optional(),
  paymentType: z.enum(["P", "C", "3"]).optional(),

  /** Fixed goods description on the label when an order has no better
   * value (Aramex requires a non-empty `DescriptionOfGoods`). */
  defaultGoodsDescription: z.string().trim().min(1).max(120).optional(),
  /** Default parcel weight in kg when the order carries none. Aramex
   * requires `ActualWeight` — never silently sent as 0. */
  defaultWeightKg: z.number().positive().max(200).optional(),

  labelReportId: z.number().int().positive().optional(),
  labelReportType: z.enum(["URL", "RPT"]).optional(),
  source: z.number().int().positive().max(9999).optional(),

  /** When the storefront's own Aramex plugin already creates the AWB at
   * checkout, set this so ASODITECH links the existing waybill (manual
   * shipment creation) instead of creating a duplicate. */
  parcelsCreatedByStore: z.boolean().optional(),

  shippingBaseUrl: z.string().url().optional(),
  trackingBaseUrl: z.string().url().optional(),
  rateBaseUrl: z.string().url().optional(),
  /** Base of the public tracking site whose `?ShipmentNumber=` page the
   * operator opens. Defaults to `https://www.aramex.com`. `https:` only. */
  trackingSiteBaseUrl: z
    .string()
    .url()
    .refine((u) => new URL(u).protocol === "https:", "L'URL de suivi Aramex doit utiliser HTTPS.")
    .optional(),
  requestTimeoutMs: z.number().int().min(1000).max(60_000).optional(),
});
export type AramexConfig = z.infer<typeof aramexConfigSchema>;

// ---------------------------------------------------------------------------
// API response schemas — deliberately permissive
// ---------------------------------------------------------------------------

/** One entry of the `Notifications` array Aramex returns on every response. */
export const aramexNotificationSchema = z
  .object({
    Code: z.union([z.string(), z.number()]).optional(),
    Message: z.string().optional(),
  })
  .passthrough();

/** Common envelope wrapper — `HasErrors` + `Notifications` sit at the top
 * of every Aramex JSON response. */
export const aramexEnvelopeSchema = z
  .object({
    HasErrors: z.boolean().optional(),
    Notifications: z.array(aramexNotificationSchema).optional(),
  })
  .passthrough();

const aramexLabelSchema = z
  .object({
    LabelURL: z.string().optional(),
    LabelFileContents: z.unknown().optional(),
  })
  .passthrough();

/** One processed shipment in a `CreateShipments` response. */
export const aramexProcessedShipmentSchema = z
  .object({
    ID: z.union([z.string(), z.number()]).optional(),
    Reference1: z.string().optional(),
    ForeignHAWB: z.string().optional(),
    ShipmentNumber: z.union([z.string(), z.number()]).optional(),
    HasErrors: z.boolean().optional(),
    Notifications: z.array(aramexNotificationSchema).optional(),
    ShipmentLabel: aramexLabelSchema.optional(),
  })
  .passthrough();

export const aramexCreateShipmentsResponseSchema = aramexEnvelopeSchema.extend({
  Shipments: z.array(aramexProcessedShipmentSchema).optional(),
});

/** One tracking update ("Value" entries of a `TrackingResults` pair). */
export const aramexTrackingUpdateSchema = z
  .object({
    WaybillNumber: z.union([z.string(), z.number()]).optional(),
    UpdateCode: z.union([z.string(), z.number()]).optional(),
    UpdateDescription: z.string().optional(),
    UpdateDateTime: z.string().optional(),
    UpdateLocation: z.string().optional(),
    Comments: z.string().optional(),
    ProblemCode: z.union([z.string(), z.number()]).optional(),
    GrossWeight: z.union([z.string(), z.number()]).optional(),
    ChargeableWeight: z.union([z.string(), z.number()]).optional(),
    WeightUnit: z.string().optional(),
  })
  .passthrough();

/**
 * `TrackShipments` response. Aramex serialises the per-waybill result map
 * as an array of `{ Key, Value }` pairs (`TrackingResults`). Some gateway
 * versions instead return a plain object keyed by waybill — both tolerated.
 */
export const aramexTrackShipmentsResponseSchema = aramexEnvelopeSchema.extend({
  TrackingResults: z
    .union([
      z.array(
        z
          .object({
            Key: z.union([z.string(), z.number()]).optional(),
            Value: z
              .union([z.array(aramexTrackingUpdateSchema), aramexTrackingUpdateSchema])
              .optional(),
          })
          .passthrough()
      ),
      z.record(z.string(), z.union([z.array(aramexTrackingUpdateSchema), aramexTrackingUpdateSchema])),
    ])
    .optional(),
  NonExistingWaybills: z.array(z.union([z.string(), z.number()])).optional(),
});

/** `CalculateRate` response — the total shipping charge for a route. */
export const aramexCalculateRateResponseSchema = aramexEnvelopeSchema.extend({
  TotalAmount: z
    .object({
      Value: z.union([z.string(), z.number()]).optional(),
      CurrencyCode: z.string().optional(),
    })
    .passthrough()
    .optional(),
});
