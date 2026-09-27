import type { IntegrationProvider, ProductStatus } from "@prisma/client";

/**
 * Batch 13 (Product Publishing) — pure eligibility check, no network, no
 * Prisma. Deliberately conservative: only checks facts already guaranteed
 * missing/wrong would make publication meaningless or (for Shopify
 * variants) something this adapter cannot yet represent — never a made-up
 * provider field requirement. See each client's own `createProduct` doc
 * comment for what the actual API calls need; everything genuinely
 * REQUIRED by the API (name, sku) is already guaranteed by this app's own
 * NOT NULL/unique constraints at product-creation time, so it is never
 * re-checked here.
 */

export interface EligibilityInput {
  status: ProductStatus;
  price: number;
  variationCount: number;
}

export interface EligibilityResult {
  eligible: boolean;
  missingFields: string[];
}

export function checkProductPublishEligibility(
  product: EligibilityInput,
  provider: IntegrationProvider
): EligibilityResult {
  const missingFields: string[] = [];

  // A draft/archived product is explicitly "not meant to be sellable yet"
  // (see mapProductStatus's own reasoning, both providers) — publishing one
  // would create a live external product for something this app itself
  // doesn't consider ready.
  if (product.status !== "ACTIF") {
    missingFields.push("Statut « Actif »");
  }
  if (!(product.price > 0)) {
    missingFields.push("Prix de vente");
  }
  // Shopify: only a simple (single-variant) product is supported in this
  // batch (see ShopifyClient.createProduct's own doc comment) — a variable
  // product is refused here rather than silently flattened to one variant
  // (Section 8/21 of the Batch 13 spec: "do not flatten meaningful variation
  // data"). WooCommerce has no such limitation.
  if (provider === "SHOPIFY" && product.variationCount > 1) {
    missingFields.push("Produit à variantes non encore pris en charge pour Shopify");
  }

  return { eligible: missingFields.length === 0, missingFields };
}
