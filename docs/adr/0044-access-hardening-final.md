# ADR 0044 — Final access hardening (Phase 4C)

## Status
Accepted (2026-09-30). Closes the three "known limits" of ADR 0043. No schema
change, no migration, no historical data rewritten.

## Decision

### Order product search: no purchase cost without `finance.view`
`searchProductsForOrderAction` (the order form's product picker, `orders.create`)
returned product AND variation `cost` to every caller; the order form never used
it. It now returns `cost: null` (product and each variation) unless the caller
holds `finance.view` — same response shape for everyone, so the order form is
unchanged. Pricing, reservation, creation and fulfilment are untouched.

### Product cost in the audit trail
Only two events ever recorded purchase-cost values, both `product.updated`:
operational settings (`previousValue/newValue.cost`) and the inline variation
cost (`previousValue/newValue.cost`). `audit.view` does not imply `finance.view`.

- **Future events** record *that* the cost changed (`newValue.costChanged:
  boolean`), never the values. Every non-sensitive field (trackInventory,
  lowStockThreshold, variation SKU, actor, time, entity) is still recorded.
- **Historical events are not rewritten** (the log is append-only). The only
  ordinary audit read surface, `/journal-audit`, never rendered payloads; its
  loader (`listAuditJournal`, `src/lib/queries/audit.ts`) now selects exactly the
  rendered columns, so payloads (`previousValue/newValue/metadata`) and request
  details are never even loaded there. The per-entity timelines (orders, stock
  transfers, stocktakes) never read Product events.

Out of scope, unchanged: `reception.validated` records a reception `totalCost`
(purchasing data, `purchases.*`), shipment events record delivery `cost` (not a
purchase cost), and the encrypted backup export (`settings.manage`, OWNER/ADMIN)
contains the full audit table by design.

### STORE_SELLER role change gated like invitation
`updateUserRoleAction` refuses `STORE_SELLER` without the `offlineSales`
capability (an `ONLINE_ONLY` tenant), server-side. `ONLINE_AND_OFFLINE` and every
other role change are unchanged. (The role select on /utilisateurs still lists the
option in an ONLINE_ONLY tenant; choosing it is refused with an explanatory error.)

## Consequences / limits
- Historical `product.updated` rows written before Phase 4C still hold cost values
  in their payload; they are unreachable through the application's read surfaces,
  and readable only with direct database access or a full backup.
- The audit trail no longer shows the old/new cost of a manual cost edit — only
  who changed it and when. Receptions and inventory movements keep their own
  per-unit purchase prices.
