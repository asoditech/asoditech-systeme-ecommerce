import { userHasPermission, type Permission } from "@/lib/auth/permissions";

/**
 * Procurement-cost visibility (Phase 4A, G3 — docs/adr/0042; revised by
 * docs/adr/0052). PURE on purpose, like effective-access.ts, so the rule is
 * unit-testable on its own. Three distinct things:
 *
 * - `cost` — the product / variation cost (`Product.cost`), the basis of
 *   margins, COGS and stock valuation: `finance.view`.
 * - `purchasePrices` — OPERATIONAL purchase prices: reception unit prices and
 *   totals, "Dernier prix d'achat" / purchase-price history, a reception
 *   movement's unit cost in traceability: `purchases.view` (whoever runs
 *   receptions sees what was paid per unit — ADR 0052).
 * - `supplierAccounts` — supplier balances, amounts paid / owed, purchase
 *   payments: finance data, `finance.view` AND `purchases.view`.
 *
 * `products.view` alone never reveals any of them.
 *
 * Presentation / read boundary only: nothing about how costs are stored,
 * computed or snapshotted changes.
 */
export function productCostVisibility(user: { permissions: ReadonlySet<Permission> }): {
  /** Product / variation purchase cost. */
  cost: boolean;
  /** Reception unit prices / totals, "Dernier prix d'achat", purchase history, reception movement unit cost. */
  purchasePrices: boolean;
  /** Supplier balances, paid / owed amounts, purchase payments. */
  supplierAccounts: boolean;
} {
  const cost = userHasPermission(user, "finance.view");
  const purchasePrices = userHasPermission(user, "purchases.view");
  return { cost, purchasePrices, supplierAccounts: cost && purchasePrices };
}
