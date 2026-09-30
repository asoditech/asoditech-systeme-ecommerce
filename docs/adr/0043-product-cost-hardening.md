# ADR 0043 — Product cost hardening + store-seller follow-ups (Phase 4B)

## Status
Accepted (2026-09-30). Follows ADR 0042 (STORE_SELLER role, Phase 4A), which
listed these items as known limits. No schema change, no migration.

## Decision

### Purchase cost is `finance.view` data — for writes and for payloads
ADR 0042 hid the cost on the product detail page; the edit paths still carried it.

- **Server, the real boundary** (`src/actions/products.ts`): without
  `finance.view` a submitted `cost` is ignored — a create stores none, an
  update leaves the stored value untouched (it is never wiped by omission).
  This covers product create/update, variation create/details and the
  product operational settings. The two actions whose only purpose is a cost
  write — `updateVariationOperationalSettingsAction` (inline variation cost)
  and `backfillProductCostSnapshotsAction` (fills historical sale-line cost
  snapshots) — refuse outright.
- **Payloads**: the product edit form, operational settings and variant edit
  dialog take `canEditCost`; without it the cost field is not rendered and no
  cost is passed to the client. The edit form now receives the product's own
  columns only (`Prisma.ProductScalarFieldEnum`), never its relations —
  previously the whole detail object, variation costs included, was spread
  into the client component.
- **Reception search** (`lookupSellableUnitsAction`): same response shape for
  everyone; `cost: null` without `finance.view`, so the reception form starts
  its price field at 0. Reception stock logic is unchanged.

Unchanged: `Product.cost` / `ProductVariation.cost` semantics, costing methods,
reception costing, sale/order cost snapshots, reports.

### AI low-stock tool is location-scoped
`toolLowStockProducts` uses `getLowStockCountForViewer` (ADR 0042, G5): OWNER/
ADMIN tenant-wide, everyone else only their active assigned locations, zero
locations → 0. Tools now receive the running user (`AiTool.run(viewer)`); no
tool's permission changed.

### STORE_SELLER only where it can work
Its four permissions are inert without the `offlineSales` capability (ADR 0041).
The invite form no longer offers it in an `ONLINE_ONLY` tenant, and
`inviteUserAction` refuses it there. `ONLINE_AND_OFFLINE` is unchanged.

### Dashboard
The "Activité" section renders only when one of its cards can (`orders.view`
or `audit.view`) — a STORE_SELLER no longer sees a bare heading.

## Known limits (not in this phase)
- `searchProductsForOrderAction` (order form product search) still returns
  `cost` to `orders.create` holders; the order form never uses it.
- Audit events of product updates record cost values, readable with `audit.view`.
- `getLatestPurchasePriceAction` / reception unit prices remain visible to
  `purchases.*` holders on the reception screens (supplier data by design).
- Changing an existing user's role to STORE_SELLER in an `ONLINE_ONLY` tenant
  is not gated (only invitation is).
