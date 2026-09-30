import { userHasPermission, type Permission } from "@/lib/auth/permissions";

/**
 * Procurement-cost visibility on product pages (Phase 4A, G3 —
 * docs/adr/0042-store-seller-role.md). PURE on purpose, like
 * effective-access.ts, so the rule is unit-testable on its own.
 *
 * A purchase cost — `Product.cost` / `ProductVariation.cost`, and the
 * reception unit prices shown as "Dernier prix d'achat" / purchase history —
 * is financial data: it is shown only to a viewer holding `finance.view`,
 * the same gate the product LIST already used for its cost column.
 * `products.view` alone never reveals it. Purchase-price history additionally
 * keeps its own `purchases.view` gate (it is supplier data too).
 *
 * Presentation / read boundary only: nothing about how costs are stored,
 * computed or snapshotted changes.
 */
export function productCostVisibility(user: { permissions: ReadonlySet<Permission> }): {
  /** Product / variation purchase cost. */
  cost: boolean;
  /** Reception unit prices ("Dernier prix d'achat", purchase history). */
  purchasePrices: boolean;
} {
  const cost = userHasPermission(user, "finance.view");
  return { cost, purchasePrices: cost && userHasPermission(user, "purchases.view") };
}
