# ADR 0056 — Location-scoped in-app notifications

## Status
Accepted (2026-10-02). No schema change, no migration. Extends ADR 0016
(notifications) with the read-side location rule of ADR 0050.

## Problem
`notify()` chose recipients by tenant + active status + effective permission
only. A low-stock / out-of-stock alert for Store B therefore reached a Store A
user with `inventory.view` — revealing another location's product and stock
level that every location-scoped page already hides from them.

## Decision
`notify()` takes an optional `warehouseId`. When set (a location-bound event),
a recipient must additionally pass `canReadWarehouse` — OWNER/ADMIN always;
everyone else only with a `UserLocation` row for that location (one batched
query per event). Final rule: same tenant + ACTIVE + effective permission +
authorized for the location. Without `warehouseId`, behaviour is unchanged.

Scoped: `checkAndNotifyLowStock` (STOCK_FAIBLE / RUPTURE_STOCK) — one
InventoryItem is exactly one location. Every location event source reaches it:
stock adjustments, physical returns, order fulfilment, POS sales and returns,
transfers (source and destination items separately), stocktakes.

Deduplication (`@@unique([userId, dedupeKey])`), the per-day low-stock bucket
and automatic clearing on recovery are unchanged.

## Intentionally NOT location-scoped
- `STOCK_INSUFFISANT_COMMANDE` — an Online order is compared with the stock
  available across ALL locations; no single location is affected.
- Order, payment, return-status, shipment, sync/integration, support, workflow
  and usage notifications — not location events (Online orders have no
  location model, ADR 0050).
- There is no dedicated POS / transfer / stocktake-discrepancy notification
  today; those flows notify only through the scoped low-stock helper.

## Note
Notifications already delivered before this change are not retroactively
removed.
