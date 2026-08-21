import { z } from "zod";

/**
 * Zod schemas for the subset of the Shopify Admin GraphQL API (2026-07)
 * response shape this adapter actually uses. External JSON is never
 * trusted directly — every response is parsed through one of these before
 * being mapped into an internal model (see mapper.ts).
 *
 * Field names/shapes were verified against Shopify's official GraphQL
 * Admin API reference during Phase 21 rather than assumed from memory —
 * see docs/adr/0011-shopify-integration.md. GraphQL ids (`gid://shopify/...`)
 * are kept as opaque strings and stored as-is as `externalId` — they are
 * already globally unique per resource and are exactly what mutations
 * (e.g. inventorySetQuantities) expect back.
 */

const moneySchema = z
  .object({ shopMoney: z.object({ amount: z.string(), currencyCode: z.string() }) })
  .transform((v) => ({ amount: Number(v.shopMoney.amount), currency: v.shopMoney.currencyCode }));

export const shopifyLocationSchema = z.object({
  id: z.string(),
  name: z.string(),
  isActive: z.boolean().default(true),
});
export type ShopifyLocation = z.infer<typeof shopifyLocationSchema>;

export const shopifyInventoryQuantitySchema = z.object({
  name: z.string(),
  quantity: z.number(),
});

export const shopifyInventoryLevelSchema = z.object({
  location: z.object({ id: z.string() }),
  quantities: z.array(shopifyInventoryQuantitySchema).default([]),
});

export function availableFrom(levels: { location: { id: string }; quantities: { name: string; quantity: number }[] }[], locationId: string): number | null {
  const level = levels.find((l) => l.location.id === locationId);
  if (!level) return null;
  const q = level.quantities.find((x) => x.name === "available");
  return q ? q.quantity : null;
}

export const shopifyVariantSchema = z.object({
  id: z.string(),
  title: z.string(),
  sku: z.string().nullish(),
  price: z.string(),
  inventoryItem: z.object({
    id: z.string(),
    tracked: z.boolean().default(true),
    inventoryLevels: z.object({
      nodes: z.array(shopifyInventoryLevelSchema).default([]),
    }),
  }),
});
export type ShopifyVariant = z.infer<typeof shopifyVariantSchema>;

export const shopifyProductSchema = z.object({
  id: z.string(),
  title: z.string(),
  handle: z.string(),
  status: z.string(), // ACTIVE | ARCHIVED | DRAFT
  descriptionHtml: z.string().nullish(),
  variants: z.object({ nodes: z.array(shopifyVariantSchema).default([]) }),
});
export type ShopifyProduct = z.infer<typeof shopifyProductSchema>;

const addressSchema = z
  .object({
    firstName: z.string().nullish(),
    lastName: z.string().nullish(),
    address1: z.string().nullish(),
    address2: z.string().nullish(),
    city: z.string().nullish(),
    province: z.string().nullish(),
    country: z.string().nullish(),
    phone: z.string().nullish(),
  })
  .nullish();

export const shopifyLineItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  sku: z.string().nullish(),
  quantity: z.number(),
  variant: z.object({ id: z.string() }).nullish(),
  product: z.object({ id: z.string() }).nullish(),
  originalUnitPriceSet: moneySchema,
  discountedTotalSet: moneySchema,
  originalTotalSet: moneySchema,
});

export const shopifyRefundSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  note: z.string().nullish(),
  totalRefundedSet: moneySchema,
});

export const shopifyOrderSchema = z.object({
  id: z.string(),
  name: z.string(), // e.g. "#1001"
  createdAt: z.string(),
  displayFinancialStatus: z.string().nullish(),
  displayFulfillmentStatus: z.string().nullish(),
  cancelledAt: z.string().nullish(),
  cancelReason: z.string().nullish(),
  customer: z
    .object({
      id: z.string(),
      email: z.string().nullish(),
      firstName: z.string().nullish(),
      lastName: z.string().nullish(),
      phone: z.string().nullish(),
    })
    .nullish(),
  email: z.string().nullish(),
  phone: z.string().nullish(),
  shippingAddress: addressSchema,
  billingAddress: addressSchema,
  paymentGatewayNames: z.array(z.string()).default([]),
  note: z.string().nullish(),
  currentTotalPriceSet: moneySchema,
  subtotalPriceSet: moneySchema,
  totalDiscountsSet: moneySchema.nullish(),
  totalShippingPriceSet: moneySchema,
  totalRefundedSet: moneySchema,
  lineItems: z.object({ nodes: z.array(shopifyLineItemSchema).default([]) }),
  refunds: z.array(shopifyRefundSchema).default([]),
});
export type ShopifyOrder = z.infer<typeof shopifyOrderSchema>;

const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() });

export const shopifyLocationsPageSchema = z.object({
  locations: z.object({ nodes: z.array(shopifyLocationSchema).default([]), pageInfo: pageInfoSchema }),
});

export const shopifyProductsPageSchema = z.object({
  products: z.object({ nodes: z.array(shopifyProductSchema).default([]), pageInfo: pageInfoSchema }),
});

export const shopifyOrdersPageSchema = z.object({
  orders: z.object({ nodes: z.array(shopifyOrderSchema).default([]), pageInfo: pageInfoSchema }),
});

export const shopifyUserErrorSchema = z.object({ field: z.array(z.string()).nullish(), message: z.string() });

export const shopifyInventorySetQuantitiesResultSchema = z.object({
  inventorySetQuantities: z.object({
    userErrors: z.array(shopifyUserErrorSchema).default([]),
  }),
});
