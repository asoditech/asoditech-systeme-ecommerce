# ADR 0042 — STORE_SELLER role + store-seller exposure hardening (Phase 4A)

## Status
Accepted (2026-09-30). Builds on ADR 0037 (location access), 0039 (overrides +
channel scope), 0040 (offline sales) and 0041 (business mode) — none of which
change. Additive migration `20260930120000_store_seller_role`.

## Context
The Store Seller / Store Manager access audit found that no existing role other
than MANAGER (and OWNER/ADMIN) holds `sales.create`/`sales.return`: a counter
seller could only be built from an unrelated role plus GRANT/DENY rows — which
the invitation flow cannot set — leaving a misleading role label and, for a
DELIVERY-based seller, Online permissions that silently return if an Online
channel is ever added. It also found four concrete exposures (G1, G2, G3, G5).

## Decision

### One new static role
`UserRole.STORE_SELLER`, with exactly:

`dashboard.view`, `sales.view`, `sales.create`, `sales.return`.

It goes through the unchanged effective-access computation
(`(role ∪ GRANT) − DENY`, then channel scope, then business mode):

- **No Online permission** in the matrix at all, so an Online channel added
  later grants nothing Online by itself.
- **Which store(s)** stays `UserChannel` + `UserLocation`: sales reads are
  channel-scoped, sale/return mutations require the location. An invited seller
  has zero `UserLocation` rows until an admin assigns one — they cannot record a
  sale before that (safe default-deny, unchanged).
- **Deliberately excluded:** `products.view` (product pages show every location's
  stock), `inventory.*`, `sales.override_price`, purchasing, finance, analytics,
  audit, traceability, customers, users, settings, `warehouses.manage`,
  `channels.manage`, `ai.use`.
- In an `ONLINE_ONLY` tenant the `sales.*` permissions are inert (ADR 0041), so
  the role holds only `dashboard.view` there.

No `STORE_MANAGER` role: MANAGER + Offline-only scope + locations covers it; the
DENY template for store managers is a separate business decision.

### Exposure fixes (no schema change)
- **G1 — sale lookup cost.** `lookupForSaleAction` returns `SellerSafeUnit`
  (`toSellerSafeUnit`, `src/lib/catalog/lookup.ts`): the sellable unit rebuilt
  field by field **without `cost`**. The sale price and the sale's `costSnapshot`
  are still resolved from the database in `createSaleAction`.
- **G2 — reception cancel.** `cancelReceptionAction` resolves the reception and
  requires `UserLocation` on its destination (like create/update/validate).
- **G3 — product detail cost.** `productCostVisibility` (`src/lib/auth/cost-visibility.ts`):
  purchase cost ("Coût d'achat") needs `finance.view`, the gate the product list
  already used; reception unit prices ("Dernier prix d'achat", purchase history,
  variants' "Dernier achat") need `finance.view` **and** `purchases.view`, and are
  not fetched otherwise.
- **G5 — dashboard low-stock count.** `getLowStockCountForViewer`: OWNER/ADMIN
  tenant-wide (unchanged); everyone else only their active assigned locations;
  zero locations → 0.

## Consequences / known limits
- A user with `purchases.view` but not `finance.view` (the WAREHOUSE role) no
  longer sees reception unit prices **on the product page**; the reception pages
  themselves are unchanged.
- The product edit forms (`products.edit`) still carry the cost as a form value —
  removing it would make a save wipe the stored cost. Only a user GRANTed
  `products.edit` without `finance.view` is affected.
- `lookupSellableUnitsAction` (`products.view`, used by the reception form) and
  the AI assistant's low-stock tool are unchanged.
- Invitation still cannot pick specific channels, locations or overrides (ADR 0039
  Phase 2 behaviour unchanged): an "Offline" invite assigns every active store
  channel; an admin narrows it and assigns the location afterwards.
