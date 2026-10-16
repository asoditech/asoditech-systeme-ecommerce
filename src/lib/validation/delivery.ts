import { z } from "zod";

export const shippingProviderTypeSchema = z.enum(["MANUEL", "FLOTTE_INTERNE", "API"]);

export const createShippingProviderSchema = z.object({
  name: z.string().trim().min(2, "Le nom du prestataire est requis.").max(150),
  type: shippingProviderTypeSchema.default("MANUEL"),
  isActive: z.coerce.boolean().default(true),
});

export const updateShippingProviderSchema = createShippingProviderSchema.extend({
  id: z.string().min(1),
});

export const shipmentStatusSchema = z.enum([
  "EN_ATTENTE",
  "EN_TRANSIT",
  "LIVRE",
  "ECHEC",
  "RETOURNE",
  "ANNULE",
]);
export type ShipmentStatusValue = z.infer<typeof shipmentStatusSchema>;

/**
 * See docs/adr/0006-delivery-providers.md. Terminal: LIVRE, ANNULE,
 * RETOURNE. EN_ATTENTE can go straight to a terminal outcome: the carrier
 * is authoritative, and for a parcel created in its portal (or polled
 * infrequently) we may never observe the EN_TRANSIT step before it reports
 * "Livré" / "Retourné" / an échec.
 */
export const SHIPMENT_STATUS_TRANSITIONS: Record<ShipmentStatusValue, ShipmentStatusValue[]> = {
  EN_ATTENTE: ["EN_TRANSIT", "LIVRE", "ECHEC", "RETOURNE", "ANNULE"],
  EN_TRANSIT: ["LIVRE", "ECHEC", "RETOURNE"],
  ECHEC: ["EN_TRANSIT", "LIVRE", "RETOURNE", "ANNULE"],
  RETOURNE: [],
  LIVRE: [],
  ANNULE: [],
};

export const MANUAL_RETURN_FROM_PENDING_MESSAGE =
  "Un colis encore « En attente » n'est jamais parti : il ne peut pas être « Retourné ». Passez-le d'abord « En transit » s'il est parti, ou annulez-le s'il n'est pas parti.";

export const MANUAL_RETURN_NEVER_SHIPPED_MESSAGE =
  "Cette commande n'a jamais été expédiée : aucun colis n'a pu revenir, il ne peut donc pas être « Retourné ». Passez d'abord le colis « En transit » s'il est réellement parti, ou annulez-le.";

export const MANUAL_OUTCOME_UNKNOWN_MESSAGE =
  "Création à vérifier chez le transporteur : vérifiez son portail, puis marquez ce colis « Échec » (aucun colis chez lui) ou « Annulé » (colis existant, à lier ensuite avec « Lier un colis existant »).";

/**
 * Extra rules for a status chosen BY HAND (owner decisions 2026-10-16). A
 * carrier's own report (sync / webhook) is NOT restricted: the carrier is
 * authoritative (see the table's comment above).
 *  - « Retourné » needs a parcel that left: never from « En attente », and
 *    never while the ORDER was never shipped (`orderShipped` = order.shippedAt
 *    set) — whatever the parcel's previous status (« Échec » included). That
 *    skipped the shipping step, left the order « En préparation » with no
 *    stock out, and showed a parcel the returns workspace then refused.
 *  - A creation « à vérifier » (outcome unknown at the carrier) is settled
 *    only as « Échec » or « Annulé » — never « En transit » / « Livré » by
 *    hand, which would ship the order and deduct stock on a parcel that may
 *    not exist.
 */
export function manualShipmentTransitionProblem(
  from: ShipmentStatusValue,
  to: ShipmentStatusValue,
  context: { orderShipped?: boolean; outcomeUnknown?: boolean } = {}
): string | null {
  if (context.outcomeUnknown && to !== "ECHEC" && to !== "ANNULE") return MANUAL_OUTCOME_UNKNOWN_MESSAGE;
  if (to !== "RETOURNE") return null;
  if (from === "EN_ATTENTE") return MANUAL_RETURN_FROM_PENDING_MESSAGE;
  if (context.orderShipped === false) return MANUAL_RETURN_NEVER_SHIPPED_MESSAGE;
  return null;
}

/**
 * « Création à vérifier » — a carrier parcel-creation request was sent but
 * its outcome is unknown (timeout, 5xx, 429, lost connection; see
 * DeliveryOutcomeUnknownError), or is still in flight / was interrupted: the
 * marker is written just before the carrier call and replaced on every
 * normal outcome. No new status: the shipment stays EN_ATTENTE
 * — an ACTIVE status, so reserveShipmentSlot refuses any further parcel for
 * the order — with no externalId and a `failedReason` starting with this
 * prefix. A person resolves it after checking the carrier's portal: « Échec »
 * (no parcel there — the order can be shipped again) or « Annulé » then
 * « Lier un colis existant » (the parcel exists).
 */
export const SHIPMENT_OUTCOME_UNKNOWN_PREFIX = "À vérifier : ";

export function isShipmentOutcomeUnknown(s: { status: string; externalId: string | null; failedReason: string | null }): boolean {
  return s.status === "EN_ATTENTE" && !s.externalId && (s.failedReason?.startsWith(SHIPMENT_OUTCOME_UNKNOWN_PREFIX) ?? false);
}

export const SHIPMENT_OUTCOME_UNKNOWN_HINT =
  "Vérifiez sur le portail du transporteur. Colis absent : passez cette expédition en « Échec » pour pouvoir la recréer. Colis présent : passez-la en « Annulé » puis utilisez « Lier un colis existant » avec son numéro de suivi.";

export function canTransitionShipmentStatus(from: ShipmentStatusValue, to: ShipmentStatusValue): boolean {
  if (from === to) return false;
  return SHIPMENT_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Whether « Annuler » (cancel AT the carrier) may be offered for a parcel:
 * the connector must support it AND the local status must allow ANNULE —
 * the carrier is called first, so offering it from e.g. EN_TRANSIT would
 * cancel the parcel at the carrier while the local transition then fails.
 * cancelShipmentViaProvider enforces the same rule server-side.
 */
export function canCancelCarrierShipment(status: ShipmentStatusValue, connectorSupportsCancel: boolean): boolean {
  return connectorSupportsCancel && canTransitionShipmentStatus(status, "ANNULE");
}

export const createShipmentSchema = z.object({
  orderId: z.string().min(1),
  providerId: z.string().min(1, "Le prestataire de livraison est requis."),
  trackingNumber: z.string().trim().max(100).nullish().or(z.literal("")),
  trackingUrl: z.union([z.url(), z.literal("")]).nullish(),
  cost: z.coerce.number().min(0).nullish(),
  notes: z.string().trim().max(2000).nullish().or(z.literal("")),
});

export const SHIPMENT_FAILED_REASON_MIN = 3;

export const updateShipmentStatusSchema = z
  .object({
    id: z.string().min(1),
    status: shipmentStatusSchema,
    failedReason: z.string().trim().max(1000).nullish().or(z.literal("")),
  })
  // A failure set by hand must say why — it is shown on the shipment, in
  // the failure notification and in « À expédier ». (Carrier-reported
  // failures go through the provider sync, not this schema.)
  .refine((v) => v.status !== "ECHEC" || (v.failedReason ?? "").length >= SHIPMENT_FAILED_REASON_MIN, {
    path: ["failedReason"],
    message: "Indiquez la raison de l'échec (au moins 3 caractères).",
  });

/** A blank/empty money field → `null` ("not configured"), else a
 * non-negative number. Used by the provider pricing-rules form. */
const optionalMoney = z
  .union([z.literal(""), z.coerce.number().min(0, "Le montant ne peut pas être négatif.")])
  .nullish()
  .transform((v) => (v === "" || v === undefined ? null : v));

/**
 * Merchant rules for NON-successful delivery outcomes on a provider (docs/
 * adr/0032). A successful delivery's price always comes from the carrier's
 * API for an API provider — it is NOT set here.
 */
export const updateShippingProviderPricingSchema = z.object({
  id: z.string().min(1),
  returnCost: optionalMoney,
  failureCost: optionalMoney,
});

/**
 * Explicit accounting correction of a shipment's recorded cost (docs/adr/
 * 0032). Permission-gated, audited, never an automatic fallback.
 */
export const overrideShipmentCostSchema = z.object({
  id: z.string().min(1),
  cost: z.coerce.number().min(0, "Le coût ne peut pas être négatif."),
  reason: z.string().trim().min(3, "Indiquez le motif de la correction.").max(500),
});

/** "Lier un colis existant" — attach a parcel already created in the
 * carrier's own portal / by the storefront plugin to a local order, then
 * pull its current status. API providers only. */
export const linkExistingShipmentSchema = z.object({
  orderId: z.string().min(1),
  providerId: z.string().min(1, "Le prestataire de livraison est requis."),
  trackingNumber: z.string().trim().min(1, "Le numéro de suivi est requis.").max(100),
  notes: z.string().trim().max(2000).nullish().or(z.literal("")),
});

export type CreateShipmentInput = z.infer<typeof createShipmentSchema>;

// --- API connector schemas (Phase 22) ---
// See docs/adr/0012-delivery-provider-integration.md.

/**
 * Credentials/config are adapter-defined (see
 * src/lib/integrations/delivery/types.ts) — this only validates the
 * envelope (must be a JSON object), never specific field names, since no
 * production adapter is registered yet to define them.
 */
export const configureDeliveryProviderApiSchema = z.object({
  providerId: z.string().min(1),
  providerKey: z.string().trim().min(1, "Sélectionnez un connecteur."),
  credentialsJson: z
    .string()
    .trim()
    .refine(
      (value) => {
        try {
          const parsed = JSON.parse(value);
          return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
        } catch {
          return false;
        }
      },
      { message: "Les identifiants doivent être un objet JSON valide." }
    ),
  configJson: z
    .string()
    .trim()
    .optional()
    .refine(
      (value) => {
        if (!value) return true;
        try {
          const parsed = JSON.parse(value);
          return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
        } catch {
          return false;
        }
      },
      { message: "La configuration doit être un objet JSON valide." }
    ),
});

export const createShipmentViaProviderSchema = z.object({
  orderId: z.string().min(1),
  providerId: z.string().min(1, "Le prestataire de livraison est requis."),
  notes: z.string().trim().max(2000).nullish().or(z.literal("")),
});

export const providerIdSchema = z.object({ providerId: z.string().min(1) });

// --- Generic provider city mapping (Phase 31) ---
// See docs/adr/0018-delivery-city-mapping.md. Provider-agnostic: no field
// is specific to any one carrier. `providerCityId` is whatever string the
// provider documents as its identifier (a number arrives as its string
// form) and is re-validated server-side against the provider's catalogue
// when one is available — the client can never get an arbitrary id
// persisted. `providerCityName` from the client is only a hint; the action
// overwrites it from the catalogue entry.
export const createDeliveryCityMappingSchema = z.object({
  providerId: z.string().min(1),
  localCity: z.string().trim().min(1, "La ville locale est requise.").max(150),
  providerCityId: z.string().trim().min(1, "Sélectionnez la ville du transporteur.").max(200),
  providerCityName: z.string().trim().max(200).optional(),
});

export const updateDeliveryCityMappingSchema = z.object({
  id: z.string().min(1),
  providerCityId: z.string().trim().min(1, "Sélectionnez la ville du transporteur.").max(200),
  providerCityName: z.string().trim().max(200).optional(),
});

export const deliveryCityMappingIdSchema = z.object({ id: z.string().min(1) });
export const shipmentIdSchema = z.object({ shipmentId: z.string().min(1) });
export const shippingProviderIdSchema = z.object({ id: z.string().min(1) });

/**
 * Bon de Livraison / manifest generation — see
 * docs/adr/0015-delivery-manifest.md. `shipmentIds` arrives as a
 * comma-separated list of local Shipment ids from the checkbox form.
 */
export const generateManifestSchema = z.object({
  providerId: z.string().min(1, "Le prestataire est requis."),
  shipmentIds: z
    .string()
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    )
    .pipe(
      z
        .array(z.string().min(1))
        .min(1, "Sélectionnez au moins une expédition.")
        .max(200, "Un bon de livraison ne peut pas dépasser 200 colis.")
    ),
});
