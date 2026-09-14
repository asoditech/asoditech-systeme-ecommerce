import { z } from "zod";

/**
 * One order-line's physical return quantities (docs/adr/0036-inventory-single-source-of-truth.md).
 * At least one of sellable/damaged must be positive — a line always
 * represents units that were actually physically received back. The
 * server action is the real ceiling authority (transactional, against
 * what EXPEDIEE actually consumed minus what was already returned); this
 * schema only rejects the obviously-invalid shape.
 */
export const physicalReturnLineInputSchema = z
  .object({
    orderItemId: z.string().min(1),
    quantitySellable: z.coerce.number().int().min(0).default(0),
    quantityDamaged: z.coerce.number().int().min(0).default(0),
  })
  .refine((line) => line.quantitySellable > 0 || line.quantityDamaged > 0, {
    message: "Chaque ligne doit avoir au moins une unité retournée (revendable ou endommagée).",
    path: ["quantitySellable"],
  });

export const confirmPhysicalReturnSchema = z.object({
  orderId: z.string().min(1),
  // Client-generated once when the return dialog opens (never regenerated
  // on re-render) — a retry of the exact same (orderId, idempotencyKey) is
  // a no-op, never a second return event. Same convention as WebhookEvent's
  // deliveryId.
  idempotencyKey: z.string().min(1).max(200),
  note: z.string().trim().max(2000).nullish().or(z.literal("")),
  lines: z.array(physicalReturnLineInputSchema).min(1, "Ajoutez au moins une ligne retournée."),
});

export type ConfirmPhysicalReturnInput = z.input<typeof confirmPhysicalReturnSchema>;
