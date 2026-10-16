import "server-only";

import { z } from "zod";

/**
 * Sendit — credential / config shapes and response schemas.
 *
 * SOURCE: the official public spec (https://app.sendit.ma/docs/api-docs.json)
 * and the owner's Swagger export. Nothing here has been verified against a
 * live Sendit account yet (see ./index.ts `SENDIT_VERIFICATION`).
 *
 * Schemas are permissive (`.passthrough()`, string|number unions) and capture
 * only what the mapper reads; the mapper decides what is mandatory.
 */

/** Fixed API base (official spec `servers`). Never overridable by tenant
 * config — the client only talks to this host. */
export const SENDIT_BASE_URL = "https://app.sendit.ma/api/v1";

// ---------------------------------------------------------------------------
// Credentials & config
// ---------------------------------------------------------------------------

/** Documented login body is `{ public_key, secret_key }`. Stored encrypted,
 * never logged, never returned to the browser. */
export const senditCredentialsSchema = z.object({
  publicKey: z.string().trim().min(1, "La clé publique Sendit est requise."),
  secretKey: z.string().trim().min(1, "La clé secrète Sendit est requise."),
});
export type SenditCredentials = z.infer<typeof senditCredentialsSchema>;

const zeroOrOne = z.union([z.literal(0), z.literal(1)]);

/**
 * Non-secret per-instance configuration.
 *
 * `pickupDistrictId` — Sendit's `pickup_district_id` (pickup city id, see
 * `GET /districts/pickup-cities`). Optional: the doc does not mark it
 * required on create and documents no default for create (46 = Casablanca
 * is only documented as the default of the `/districts` fee query).
 *
 * `allowOpen` / `allowTry` — documented 0|1 flags. Omitted from the create
 * body when not configured (Sendit's default is undocumented).
 */
export const senditConfigSchema = z.object({
  pickupDistrictId: z.number().int().positive().optional(),
  allowOpen: zeroOrOne.optional(),
  allowTry: zeroOrOne.optional(),
  /** `printFormat` sent to POST /deliveries/getlabels. Its allowed values
   * are undocumented; the spec's example is 1, used when not configured. */
  labelPrintFormat: z.number().int().positive().optional(),
});
export type SenditConfig = z.infer<typeof senditConfigSchema>;

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const idLike = z.union([z.string(), z.number()]);
const numLike = z.union([z.number(), z.string()]);
const flagLike = z.union([z.number(), z.string(), z.boolean()]);

/** Every documented response: `{ success, message, data }`. */
export const senditEnvelopeSchema = z
  .object({
    success: z.boolean(),
    message: z.string().nullish(),
    data: z.unknown().optional(),
  })
  .passthrough();

/** Documented pagination keys, added at envelope level on list endpoints. */
export const senditPaginationSchema = z
  .object({
    total: numLike.nullish(),
    per_page: numLike.nullish(),
    current_page: numLike.nullish(),
    last_page: numLike.nullish(),
    next_page_url: z.string().nullish(),
    prev_page_url: z.string().nullish(),
  })
  .passthrough();

/** POST /login → data `{ token, name }` (name = account email). */
export const senditLoginDataSchema = z
  .object({
    token: z.string().optional(),
    name: z.string().nullish(),
  })
  .passthrough();

export const senditDistrictSchema = z
  .object({
    id: idLike.optional(),
    ville: z.string().nullish(),
    name: z.string().nullish(),
    arabic_name: z.string().nullish(),
    price: numLike.nullish(),
    delais: z.union([z.string(), z.number()]).nullish(),
    active: flagLike.nullish(),
    pickup_district: z.unknown().optional(),
  })
  .passthrough();

export const senditPickupCitySchema = z
  .object({
    id: idLike.optional(),
    name: z.string().nullish(),
    arabic_name: z.string().nullish(),
  })
  .passthrough();

export const senditDeliveryProductSchema = z
  .object({
    reference: z.string().nullish(),
    code: z.string().nullish(),
    name: z.string().nullish(),
    quantity: numLike.nullish(),
  })
  .passthrough();

/** One entry of the `audits` array of a delivery detail (history). */
export const senditAuditSchema = z
  .object({
    data: z
      .object({
        status: z.string().nullish(),
        status_return: z.string().nullish(),
        last_action_at: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    event: z.string().nullish(),
    user: z.string().nullish(),
    created_at: z.string().nullish(),
  })
  .passthrough();

/** « Détails colis » — create / detail / update response `data`. */
export const senditDeliveryDetailSchema = z
  .object({
    code: idLike.optional(),
    status: z.string().nullish(),
    fee: numLike.nullish(),
    name: z.string().nullish(),
    phone: z.union([z.string(), z.number()]).nullish(),
    address: z.string().nullish(),
    amount: numLike.nullish(),
    comment: z.string().nullish(),
    reference: z.string().nullish(),
    products: z.array(senditDeliveryProductSchema).nullish(),
    products_from_stock: flagLike.nullish(),
    district: senditDistrictSchema.nullish(),
    last_action_at: z.string().nullish(),
    allow_open: flagLike.nullish(),
    allow_try: flagLike.nullish(),
    status_return: z.string().nullish(),
    option_exchange: flagLike.nullish(),
    labelUrl: z.string().nullish(),
    audits: z.array(z.unknown()).nullish(),
  })
  .passthrough();

/** POST /deliveries/getlabels → data `{ filePrint, fileUrl }`. */
export const senditLabelsDataSchema = z
  .object({
    filePrint: z.boolean().nullish(),
    fileUrl: z.string().nullish(),
  })
  .passthrough();

/** GET /all-status-deliveries → data `{ CODE: "Libellé" }`. */
export const senditStatusCatalogueSchema = z.record(z.string(), z.string());

/** Documented keys of the POST/PUT /deliveries body — the ONLY keys the
 * mapper may emit. */
export const SENDIT_CREATE_BODY_KEYS = [
  "pickup_district_id",
  "district_id",
  "name",
  "amount",
  "address",
  "phone",
  "comment",
  "reference",
  "allow_open",
  "allow_try",
  "products_from_stock",
  "products",
  "packaging_id",
  "option_exchange",
  "delivery_exchange_id",
] as const;

export interface SenditCreateDeliveryBody {
  pickup_district_id?: number;
  district_id: number;
  name: string;
  amount: number;
  address: string;
  phone: string;
  comment: string | null;
  reference: string | null;
  allow_open?: 0 | 1;
  allow_try?: 0 | 1;
  products_from_stock: 0;
  products: string;
  option_exchange?: 1;
  delivery_exchange_id?: string;
}
