import { z } from "zod";

export const inventoryAdjustmentSchema = z
  .object({
    productId: z.string().min(1).nullish().or(z.literal("")),
    variationId: z.string().min(1).nullish().or(z.literal("")),
    warehouseId: z.string().min(1, "L'entrepôt est requis."),
    type: z.enum(["AJUSTEMENT_POSITIF", "AJUSTEMENT_NEGATIF", "ENDOMMAGE", "RETOUR", "RECEPTION"]),
    quantity: z.coerce.number().int().positive("La quantité doit être supérieure à zéro."),
    reason: z.string().trim().min(2, "Un motif est requis pour tout ajustement.").max(500),
  })
  .refine((v) => Boolean(v.productId) || Boolean(v.variationId), {
    message: "Sélectionnez un produit ou une variation.",
    path: ["productId"],
  });

export type InventoryAdjustmentInput = z.infer<typeof inventoryAdjustmentSchema>;
