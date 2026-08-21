import { z } from "zod";

export const productStatusSchema = z.enum(["ACTIF", "BROUILLON", "ARCHIVE"]);

const skuSchema = z
  .string()
  .trim()
  .min(2, "Le SKU est requis.")
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, "Le SKU ne peut contenir que lettres, chiffres, points, tirets.");

export const createProductSchema = z.object({
  name: z.string().trim().min(2, "Le nom du produit est requis.").max(200),
  sku: skuSchema,
  description: z.string().trim().max(10000).nullish().or(z.literal("")),
  categoryId: z.string().min(1).nullish().or(z.literal("")),
  price: z.coerce.number().min(0, "Le prix doit être positif ou nul."),
  salePrice: z.coerce.number().min(0).nullish(),
  cost: z.coerce.number().min(0).nullish(),
  status: productStatusSchema.default("BROUILLON"),
  trackInventory: z.coerce.boolean().default(true),
  lowStockThreshold: z.coerce.number().int().min(0).default(5),
});

export const updateProductSchema = createProductSchema.extend({
  id: z.string().min(1),
});

export const createCategorySchema = z.object({
  name: z.string().trim().min(2, "Le nom de la catégorie est requis.").max(120),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9-]+$/, "Le slug ne peut contenir que minuscules, chiffres, tirets."),
  description: z.string().trim().max(2000).nullish().or(z.literal("")),
  parentId: z.string().min(1).nullish().or(z.literal("")),
});

export const updateCategorySchema = createCategorySchema.extend({
  id: z.string().min(1),
});

export const createProductVariationSchema = z.object({
  productId: z.string().min(1),
  sku: skuSchema,
  attributes: z.record(z.string(), z.string()).refine((v) => Object.keys(v).length > 0, {
    message: "Ajoutez au moins un attribut (ex. Couleur, Taille).",
  }),
  price: z.coerce.number().min(0).nullish(),
  cost: z.coerce.number().min(0).nullish(),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
