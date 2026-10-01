import type { Permission } from "@/lib/auth/permissions";

/**
 * The Store Manager profile — docs/adr/0048-store-manager-access-policy.md.
 *
 * Not a role. A store manager is:
 *   role MANAGER + « Magasin » scope + the store's channel(s) and location(s)
 *   (chosen at invitation, docs/adr/0047) + these DENY overrides, applied from
 *   the user's access dialog after acceptance.
 *
 * The « Magasin » scope already removes every Online permission (orders,
 * delivery, commissions, marketing — docs/adr/0039). MANAGER never holds
 * `channels.manage`, `finance.manage` or `users.manage`, so no override is
 * needed for those.
 *
 * What remains — the store manager's working set: dashboard, store sales
 * (incl. returns and the POS price override, `sales.override_price`), stock
 * (view, adjust, transfer, count), receptions (view, create, validate),
 * supplier visibility, product catalogue read access, store reporting
 * (channel and stock reports) and traceability. Every mutation stays channel-
 * and location-scoped (docs/adr/0037, 0039).
 *
 * Purchase prices YES, finance NO (docs/adr/0052, revising 0048): holding
 * `purchases.view`, the store manager sees operational purchase prices —
 * reception unit prices and totals, the last-purchase hint and purchase-price
 * history, a reception movement's unit cost in traceability. Without
 * `finance.view`, `productCostVisibility()` still hides the product cost
 * (`Product.cost`), stock valuation, supplier balances / paid / owed amounts
 * and purchase payments; margins, profit, treasury and every finance page
 * stay refused.
 */
export const STORE_MANAGER_DENIES = [
  "finance.view",
  "purchases.pay",
  "suppliers.manage",
  "products.create",
  "products.edit",
  "warehouses.manage",
  "audit.view",
  "ai.use",
  "customers.view",
  "customers.create",
  "customers.edit",
] as const satisfies readonly Permission[];

/** The resulting effective permission set for a MANAGER on « Magasin » scope with {@link STORE_MANAGER_DENIES}. */
export const STORE_MANAGER_PERMISSIONS = [
  "dashboard.view",
  "products.view",
  "inventory.view",
  "inventory.adjust",
  "inventory.transfer",
  "inventory.count",
  "analytics.view",
  "suppliers.view",
  "purchases.view",
  "purchases.create",
  "sales.view",
  "sales.create",
  "sales.return",
  "sales.override_price",
  "traceability.view",
] as const satisfies readonly Permission[];
