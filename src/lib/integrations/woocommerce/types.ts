import { z } from "zod";

/**
 * Zod schemas for the subset of the WooCommerce REST API v3 response shape
 * this adapter actually uses. External JSON is never trusted directly —
 * every response is parsed through one of these before being mapped into
 * an internal model (see mapper.ts). Fields not listed here are ignored,
 * not fabricated. Money fields arrive from WooCommerce as strings (e.g.
 * "19.99") — coerced to numbers here since Prisma stores them as Decimal.
 *
 * Field names and shapes come from the official WooCommerce REST API docs
 * (https://woocommerce.github.io/woocommerce-rest-api-docs/), verified
 * during Phase 20 rather than assumed from memory.
 */

const wcMoneyString = z
  .string()
  .trim()
  .transform((v) => (v === "" ? 0 : Number(v)))
  .pipe(z.number());

export const wcProductCategoryRefSchema = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string(),
});

export const wcProductCategorySchema = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string(),
  parent: z.number().default(0),
  description: z.string().nullish(),
});
export type WcProductCategory = z.infer<typeof wcProductCategorySchema>;

export const wcProductSchema = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string(),
  sku: z.string().default(""),
  status: z.string(), // draft | pending | private | publish
  type: z.string().default("simple"), // simple | variable | grouped | external
  description: z.string().nullish(),
  regular_price: wcMoneyString.default(0),
  sale_price: wcMoneyString.nullish(),
  price: wcMoneyString.default(0),
  manage_stock: z.boolean().default(false),
  stock_quantity: z.number().nullish(),
  stock_status: z.string().default("instock"),
  categories: z.array(wcProductCategoryRefSchema).default([]),
  variations: z.array(z.number()).default([]),
});
export type WcProduct = z.infer<typeof wcProductSchema>;

export const wcProductVariationSchema = z.object({
  id: z.number(),
  sku: z.string().default(""),
  regular_price: wcMoneyString.default(0),
  sale_price: wcMoneyString.nullish(),
  price: wcMoneyString.default(0),
  manage_stock: z.boolean().default(false),
  stock_quantity: z.number().nullish(),
  stock_status: z.string().default("instock"),
  attributes: z
    .array(
      z.object({
        id: z.number().optional(),
        name: z.string(),
        option: z.string(),
      })
    )
    .default([]),
});
export type WcProductVariation = z.infer<typeof wcProductVariationSchema>;

const wcAddressSchema = z.object({
  first_name: z.string().default(""),
  last_name: z.string().default(""),
  company: z.string().nullish(),
  address_1: z.string().default(""),
  address_2: z.string().nullish(),
  city: z.string().default(""),
  state: z.string().nullish(),
  postcode: z.string().nullish(),
  country: z.string().default(""),
  email: z.string().nullish(),
  phone: z.string().nullish(),
});

export const wcOrderLineItemSchema = z.object({
  id: z.number(),
  name: z.string(),
  product_id: z.number().nullish(),
  variation_id: z.number().nullish(),
  sku: z.string().nullish(),
  quantity: z.number(),
  price: wcMoneyString.default(0), // unit price
  subtotal: wcMoneyString.default(0), // gross, pre-discount
  total: wcMoneyString.default(0), // net, post-discount
  total_tax: wcMoneyString.default(0),
});

export const wcOrderRefundRefSchema = z.object({
  id: z.number(),
  reason: z.string().nullish(),
  total: z.string(), // negative string, e.g. "-10.00"
});

export const wcOrderSchema = z.object({
  id: z.number(),
  number: z.string(),
  status: z.string(),
  currency: z.string().default("MAD"),
  date_created: z.string(),
  date_paid: z.string().nullish(),
  customer_id: z.number().default(0),
  total: wcMoneyString.default(0),
  total_tax: wcMoneyString.default(0),
  shipping_total: wcMoneyString.default(0),
  discount_total: wcMoneyString.default(0),
  payment_method: z.string().nullish(),
  payment_method_title: z.string().nullish(),
  customer_note: z.string().nullish(),
  // WooCommerce always includes both objects on a real order (every field
  // inside each has its own safe default/nullish handling already).
  billing: wcAddressSchema,
  shipping: wcAddressSchema,
  line_items: z.array(wcOrderLineItemSchema).default([]),
  refunds: z.array(wcOrderRefundRefSchema).default([]),
});
export type WcOrder = z.infer<typeof wcOrderSchema>;

export const wcListMetaSchema = z.object({
  totalPages: z.number(),
  total: z.number(),
});
export type WcListMeta = z.infer<typeof wcListMetaSchema>;
