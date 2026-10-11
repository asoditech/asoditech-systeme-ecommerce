import { z } from "zod";

/**
 * P3 returns workspace (/livraison/retours) — input shapes. Every schema is
 * `.strict()`: the client sends ids to act on, never a tenant, warehouse or
 * order to trust (the server derives all of those) — an extra key such as a
 * forged `tenantId` / `warehouseId` / `orderId` is rejected outright.
 */

const id = z.string().trim().min(1).max(100);

export const lookupReturnParcelSchema = z
  .object({
    /** A tracking number (exact) or an order number. */
    query: z.string().trim().min(1, "Saisissez un numéro de suivi ou de commande.").max(100),
  })
  .strict();

export const receiveReturnParcelSchema = z
  .object({
    shipmentId: id,
    /** Explicit confirmation that this is a LATER reception of a parcel
     * already received and inspected once (the units that were missing). */
    additional: z.boolean().optional().default(false),
    note: z.string().trim().max(2000).nullish(),
  })
  .strict();

export const receiveReturnParcelsSchema = z
  .object({
    shipmentIds: z.array(id).min(1, "Aucun colis sélectionné.").max(50, "50 colis au maximum par lot."),
  })
  .strict();

/** The unit condition the operator chose — required, never defaulted. */
export const RETURN_UNIT_CONDITIONS = ["SELLABLE", "DAMAGED"] as const;
export type ReturnUnitCondition = (typeof RETURN_UNIT_CONDITIONS)[number];

export const inspectionEntrySchema = z
  .object({
    orderItemId: id,
    condition: z.enum(RETURN_UNIT_CONDITIONS, { message: "Choisissez l'état de l'article (revendable ou endommagé)." }),
    quantity: z.coerce.number().int().min(1).max(100_000),
  })
  .strict();

export const inspectReturnReceptionSchema = z
  .object({
    receptionId: id,
    // Generated once when the inspection screen opens — a retry of the same
    // submission is a no-op, never a second return event.
    idempotencyKey: z.string().min(1).max(200),
    note: z.string().trim().max(2000).nullish(),
    entries: z.array(inspectionEntrySchema).min(1, "Enregistrez au moins un article inspecté.").max(500),
  })
  .strict();

/**
 * Why a reception awaiting inspection is cancelled — required, never
 * defaulted. Cancelling records that NO unit was physically received under
 * this reception (empty or wrong parcel, or its units were already returned
 * elsewhere); it never touches stock, the order or the carrier status.
 */
export const RETURN_RECEPTION_CANCEL_REASONS = ["COLIS_VIDE", "MAUVAIS_COLIS", "DEJA_RETOURNE", "AUTRE"] as const;
export type ReturnReceptionCancelReason = (typeof RETURN_RECEPTION_CANCEL_REASONS)[number];

export const RETURN_RECEPTION_CANCEL_REASON_LABELS: Record<ReturnReceptionCancelReason, string> = {
  COLIS_VIDE: "Colis vide",
  MAUVAIS_COLIS: "Mauvais colis réceptionné",
  DEJA_RETOURNE: "Unités déjà retournées par ailleurs",
  AUTRE: "Autre motif",
};

export const cancelReturnReceptionSchema = z
  .object({
    receptionId: id,
    reason: z.enum(RETURN_RECEPTION_CANCEL_REASONS, { message: "Choisissez le motif de l'annulation." }),
    note: z.string().trim().max(2000).nullish(),
  })
  .strict()
  .refine((v) => v.reason !== "AUTRE" || (v.note?.trim().length ?? 0) >= 3, {
    message: "Précisez le motif (3 caractères minimum).",
    path: ["note"],
  });

export type CancelReturnReceptionInput = z.input<typeof cancelReturnReceptionSchema>;
export type LookupReturnParcelInput = z.input<typeof lookupReturnParcelSchema>;
export type ReceiveReturnParcelInput = z.input<typeof receiveReturnParcelSchema>;
export type ReceiveReturnParcelsInput = z.input<typeof receiveReturnParcelsSchema>;
export type InspectReturnReceptionInput = z.input<typeof inspectReturnReceptionSchema>;

/** Inspection entries → per-order-item sellable / damaged totals (duplicates summed). */
export function entriesToReturnLines(
  entries: readonly { orderItemId: string; condition: ReturnUnitCondition; quantity: number }[]
): { orderItemId: string; quantitySellable: number; quantityDamaged: number }[] {
  return entries.map((e) => ({
    orderItemId: e.orderItemId,
    quantitySellable: e.condition === "SELLABLE" ? e.quantity : 0,
    quantityDamaged: e.condition === "DAMAGED" ? e.quantity : 0,
  }));
}
