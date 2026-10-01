# ADR 0048 — Store Manager access policy

## Status
Accepted (2026-09-30). Builds on ADR 0037 (locations), 0039 (overrides and
channel scope), 0043 (purchase cost), 0047 (invite-time precision). No schema
change, no migration, no new role. **Supersedes ADR 0043's "reception unit
prices remain visible to `purchases.*` holders" for viewers without
`finance.view`.**

## Decision
A **Store Manager is not a role**: it is `MANAGER` + « Magasin » scope + the
store's channel(s) and location(s) chosen at invitation (ADR 0047) + the DENY
template `STORE_MANAGER_DENIES` (`src/lib/auth/store-manager-profile.ts`),
applied from the user's access dialog after acceptance. The effective-access
algorithm, the role matrix, STORE_SELLER and OWNER/ADMIN are unchanged.

**Denied:** `finance.view`, `purchases.pay`, `suppliers.manage`,
`products.create`, `products.edit`, `warehouses.manage`, `audit.view`,
`ai.use`, `customers.view`, `customers.create`, `customers.edit`.
- `customers.*`: the POS takes a free-text customer label and never reads the
  customer base. `/clients` is the Online customer base, with contact details.
- `products.edit`: prices and catalogue settings are tenant-wide, not per store.
- No DENY for `channels.manage`, `finance.manage` or `users.manage`: MANAGER
  never holds them. The « Magasin » scope removes every Online permission.

**Resulting set (15):** `dashboard.view`, `products.view`,
`inventory.view|adjust|transfer|count`, `analytics.view`, `suppliers.view`,
`purchases.view|create`, `sales.view|create|return|override_price`,
`traceability.view`. Every mutation stays channel- and location-scoped. Read
surfaces keep ADR 0037 §6 (intentionally broad).

### Decision 1 — no purchase price for a Store Manager
Operating purchasing ≠ seeing purchase cost. Without `finance.view`
(`productCostVisibility().cost` / `.purchasePrices`), none of the following
is rendered or returned:
- product cost and margins (unchanged, ADR 0043);
- reception list totals; reception detail prices, line totals, total, paid
  and linked payments;
- supplier list received / paid / owed; supplier detail balance, received
  total, reception totals and paid, purchase-history unit prices, payments;
- the last-purchase hint and the purchase-price history
  (`getLatestPurchasePriceAction` → null, `getUnitPurchaseHistoryAction` → []);
- movement unit costs in traceability (nulled in `getUnitTraceability`);
- stock valuation: `/rapports/stock` and its CSV
  (`getStockValuationReport({ includeCost: false })`).

Receptions stay fully operational. The price of a new line is typed from the
supplier's document (it cannot be derived from anything stored). On a draft
edit, stored prices are never sent to the browser: an empty price means
« inchangé » (`unitCost: null`) and the server keeps the stored price. A unit
new to the draft needs a typed price. With `finance.view`, every screen, CSV
and action is unchanged.

Also fixed: `updateReceptionDraftAction` now checks location access on the
draft's **current** location, like validate and cancel already did. Before,
a draft of another location could be edited or moved.

### Decision 2 — `sales.override_price` kept
A store manager may adjust a selling price or discount at the POS. It is
enforced server-side in `createSaleAction`. STORE_SELLER does not hold it,
and its permission set is unchanged.

## Known, not changed here (deferred)
- **Online analytics finance gap:** with `finance.view` DENIED on an Online
  `analytics.view` holder, the `rentabilite` / `profitabilite` reports (page
  and CSV) still show cost of goods and margins, and the `tresorerie` CSV
  needs only `analytics.view` (its page needs `finance.view`). No default role
  and no store manager can reach this (Online channel required).
- **Shared store channel:** a store channel mapped to several stores exposes
  their sales to each other on read surfaces. The supported configuration is
  one store channel per physical store.
