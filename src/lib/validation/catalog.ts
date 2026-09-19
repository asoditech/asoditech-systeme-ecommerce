import { z } from "zod";

/** Model / family reference (e.g. "SKOUBA") — free-form, NOT unique. */
export const referenceSchema = z
  .string()
  .trim()
  .max(100, "La référence est limitée à 100 caractères.")
  .nullish()
  .or(z.literal(""));

export const addBarcodeSchema = z
  .object({
    productId: z.string().min(1).nullish(),
    variationId: z.string().min(1).nullish(),
    code: z.string().trim().min(1, "Le code-barres est requis.").max(64),
    makePrimary: z.coerce.boolean().optional(),
  })
  .refine((v) => Boolean(v.productId) !== Boolean(v.variationId), {
    message: "Un code-barres identifie soit un produit, soit une variation.",
    path: ["productId"],
  });
export type AddBarcodeInput = z.infer<typeof addBarcodeSchema>;

export const barcodeIdSchema = z.object({ barcodeId: z.string().min(1) });

export const updateProductReferenceSchema = z.object({
  productId: z.string().min(1),
  reference: referenceSchema,
});

export const setProductChannelsSchema = z.object({
  productId: z.string().min(1),
  salesChannelIds: z.array(z.string().min(1)),
});

export const lookupQuerySchema = z.object({
  query: z.string().trim().min(1).max(100),
  channelId: z.string().min(1).nullish(),
});
