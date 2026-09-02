import { z } from "zod";

export const productStatusSchema = z.enum(["ACTIF", "BROUILLON", "ARCHIVE"]);

const skuSchema = z
  .string()
  .trim()
  .min(2, "Le SKU est requis.")
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, "Le SKU ne peut contenir que lettres, chiffres, points, tirets.");

const baseProductSchema = z.object({
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

// A sale price above the regular price is almost always a data-entry
// mistake (it would display as a "promotion" that costs the customer more)
// — reject it rather than silently storing it. Found during the A–G audit;
// see docs/adr/0002-domain-model.md's audit addendum.
function salePriceNotAboveRegularPrice(data: { price: number; salePrice?: number | null }) {
  return data.salePrice == null || data.salePrice <= data.price;
}
const salePriceRefineOptions = {
  message: "Le prix promotionnel ne peut pas dépasser le prix normal.",
  path: ["salePrice"] as string[],
};

export const createProductSchema = baseProductSchema.refine(salePriceNotAboveRegularPrice, salePriceRefineOptions);

export const updateProductSchema = baseProductSchema
  .extend({ id: z.string().min(1) })
  .refine(salePriceNotAboveRegularPrice, salePriceRefineOptions);

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

/**
 * Fields ASODITECH remains the source of truth for even on an externally
 * (WooCommerce/Shopify) sourced product — never overwritten by a sync run
 * (see the two providers' mapper.ts "Field ownership" comments). Phase 28
 * — docs/adr/0017-product-management-boundary.md: product *definition*
 * (name/sku/price/description/status/category) moves to the platform the
 * product actually lives on; this narrower schema is what stays editable
 * from ASODITECH regardless of source.
 */
export const updateProductOperationalSettingsSchema = z.object({
  id: z.string().min(1),
  cost: z.coerce.number().min(0).nullish(),
  trackInventory: z.coerce.boolean().default(true),
  lowStockThreshold: z.coerce.number().int().min(0).default(5),
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
