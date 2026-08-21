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

/** See docs/adr/0006-delivery-providers.md. Terminal: LIVRE, ANNULE. */
export const SHIPMENT_STATUS_TRANSITIONS: Record<ShipmentStatusValue, ShipmentStatusValue[]> = {
  EN_ATTENTE: ["EN_TRANSIT", "ANNULE"],
  EN_TRANSIT: ["LIVRE", "ECHEC", "RETOURNE"],
  ECHEC: ["EN_TRANSIT", "RETOURNE", "ANNULE"],
  RETOURNE: [],
  LIVRE: [],
  ANNULE: [],
};

export function canTransitionShipmentStatus(from: ShipmentStatusValue, to: ShipmentStatusValue): boolean {
  if (from === to) return false;
  return SHIPMENT_STATUS_TRANSITIONS[from].includes(to);
}

export const createShipmentSchema = z.object({
  orderId: z.string().min(1),
  providerId: z.string().min(1, "Le prestataire de livraison est requis."),
  trackingNumber: z.string().trim().max(100).nullish().or(z.literal("")),
  trackingUrl: z.union([z.url(), z.literal("")]).nullish(),
  cost: z.coerce.number().min(0).nullish(),
  notes: z.string().trim().max(2000).nullish().or(z.literal("")),
});

export const updateShipmentStatusSchema = z.object({
  id: z.string().min(1),
  status: shipmentStatusSchema,
  failedReason: z.string().trim().max(1000).nullish().or(z.literal("")),
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
export const shipmentIdSchema = z.object({ shipmentId: z.string().min(1) });
