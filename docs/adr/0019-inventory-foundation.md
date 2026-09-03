# ADR 0019 — Inventory foundation hardening + warehouse foundation

## Status
Accepted (2026-09-03) — Phase 32a

## Context
`docs/adr/0005-inventory-and-sync.md` built the internal inventory engine:
`InventoryItem` (current-state cache) + `InventoryMovement` (append-only
ledger), kept in the same transaction. The Phase 32 audit
(`docs/adr/` predecessor discussion) found the engine sound but flagged
prerequisites before any multi-location work (transfers, stocktaking,
production):

- `applyMovement` resolved the `InventoryItem` by `findFirst({ productId })`
  with **no `warehouseId`** — correct only while exactly one (default)
  warehouse exists; ambiguous / wrong-row the moment a second location does.
- Three near-identical copies of the "increment then check post-update"
  stock-mutation logic (`applyMovement`, `adjustInventoryAction`,
  `reconcileStockFromProvider`).
- `available` stock (`max(0, onHand − reserved)`) was computed ad-hoc in
  the WooCommerce and Shopify stock-push files and mislabelled "Disponible"
  in the Stock UI (which actually showed `quantityOnHand`).
- `listInventoryItems` / `getLowStockCount` loaded the whole
  `inventory_items` table and filtered/paginated in JS.
- `Warehouse` had no way to distinguish a back-office warehouse from a
  retail store, no lifecycle (activate/retire), and no CRUD.

## Decision

### 1. `InventoryItem` is warehouse-scoped — non-negotiable
Every stock mutation targets exactly `(warehouseId, productId|variationId)`,
resolved through the existing compound unique indexes
(`@@unique([warehouseId, productId])`, `@@unique([warehouseId, variationId])`).
No code path may resolve an `InventoryItem` by product/variation alone.

### 2. One canonical primitive: `applyStockMovement(tx, input)`
`src/lib/inventory.ts`. The single way application code changes stock:
1. resolve the `InventoryItem` by `findUnique` on the compound key;
2. apply signed deltas with `increment`, re-read the **post-update** row
   inside the caller's transaction (Postgres's row lock on the `UPDATE` is
   the concurrency guard — unchanged from `docs/adr/0005`);
3. throw `InsufficientStockError` (rolling back) if on-hand went negative —
   existing policy, unchanged;
4. clamp a negative `quantityReserved` to 0 (data-drift only);
5. write the immutable `InventoryMovement` in the same transaction;
6. **silent no-op** (`applied: false`) when no row exists — an order must
   never fail to save because a product isn't stock-tracked.

Routed through it now: `reserveStockForOrder` / `fulfillStockForOrder` /
`releaseStockForOrder` / `returnStockForOrder` (order lifecycle),
`adjustInventoryAction` (manual), `reconcileStockFromProvider`
(WooCommerce / Shopify pull). Designed so future movement types (transfer,
production, stocktake — later phases) use it without another rewrite. **No
new movement types were added in 32a.**

### 3. Order → warehouse resolution (backward-compat fallback)
`reserveStockForOrder` & co. still take no `warehouseId` (Order state
machine untouched). Internally, `resolveOrderStockWarehouseId`:
1. the **default** warehouse when the product/variation has a row there
   (the dominant case — `createProductAction` seeds exactly that);
2. else its **single** `InventoryItem` row, if it has exactly one
   (preserves the old `findFirst` behaviour for a product whose only stock
   is e.g. a Shopify Location);
3. else the default warehouse id — so `applyStockMovement` no-ops rather
   than mutate an arbitrary one of several rows. **Never guesses.**

The only behavioural difference vs. the old `findFirst` is for a
product with ≥2 rows and none at the default warehouse — a case that was
already non-deterministic (arbitrary row) and is now deterministic.

### 4. `availableStock` — derived, centralised, never stored
`availableStock(item)` and `availableStockTotal(items)` in
`src/lib/inventory.ts` are the single definition, `max(0, onHand −
reserved)`. `availableStockTotal([])` returns `null` (the stock-push
callers rely on that to mean "no row, don't push a number") — byte-identical
to the former per-file `sellableQuantity()` helpers. Used by the Stock UI,
the product-detail stock tab, and both provider stock-push files. **No
`availableStock` column.**

### 5. Stock UI semantics
The Stock page and product-detail stock tab now show three distinct
columns: **Stock physique** (`quantityOnHand`), **Réservé**
(`quantityReserved`), **Disponible** (`availableStock`). "Entrepôt" →
"Emplacement".

### 6. `Warehouse` model — extended, not replaced
`WarehouseType` enum (`ENTREPOT` | `MAGASIN`), `Warehouse.type`
(default `ENTREPOT`), `isActive` (default `true`), `address`,
`createdById`. **No `Location` / `Store` model** — `Warehouse` is the one
location entity. Additive migration; existing rows default to an active
`ENTREPOT`. `isDefault` behaviour unchanged.

### 7. Warehouse CRUD + permission
`src/actions/warehouses.ts`: `create`, `update`, `setActive`. **No delete**
(an `InventoryItem`-bearing location must be kept — `onDelete: Restrict`;
deactivate instead). Provider-owned locations (`source != INTERNE`) are
read-only here (mirrors `docs/adr/0017`). The default warehouse cannot be
deactivated. A deactivated location keeps its stock and history but can no
longer receive stock-in adjustments (enforced in `adjustInventoryAction`).

New permission `warehouses.manage` — held by OWNER / ADMIN / MANAGER,
**deliberately not WAREHOUSE** (adjusting stock is operational; adding or
retiring a location is an org-structure decision). Viewing `/entrepots`
needs `inventory.view`.

Audit actions: `warehouse.created`, `warehouse.updated`,
`warehouse.activated`, `warehouse.deactivated` (deactivation of a location
still holding stock records a `warning` in `metadata`).

### 8. DB-side inventory queries
`listInventoryItems` paginates with `skip`/`take` and filters with a
Prisma `where`. The low-stock filter (a `quantityOnHand <= Product.lowStockThreshold`
comparison across a join, which Prisma's builder can't express) is a single
raw `SELECT` of matching ids, hydrated with the normal typed `include`.
`getLowStockCount` is a raw `SELECT COUNT(*)`. No denormalised counters.

### 9. Index
`@@index([inventoryItemId, createdAt])` on `InventoryMovement` (per-item
ledger view) and `@@index([isActive])` on `Warehouse`. `warehouseId` was
**not** added to `InventoryMovement` — `inventoryItemId` already implies the
warehouse, and 32a has no query that needs it.

## Consequences
- Multi-location transfers / stocktaking / production (Phases 32b–32e) can
  now call one warehouse-explicit, concurrency-safe primitive.
- Storefront stock numbers pushed to WooCommerce/Shopify are unchanged
  (regression-tested against the old calculation).
- The Order state machine, delivery, finance, product, and integration
  architectures are untouched.

## Not built in 32a (later phases)
Transfers, stocktaking, production, `TRANSFERT_*` / `PRODUCTION` /
`INVENTAIRE` movement types, any new domain model beyond the `Warehouse`
extension, warehouse pickers in the order/adjust UIs, multi-warehouse
fulfilment routing.

## Business decisions still needed before 32b / 32d
- **Overselling policy.** Reservations can still exceed available stock
  (no gate at order creation) — intended for produce-to-order, but should
  be an explicit per-product toggle or a warning before production is
  layered on.
- **Warehouse a product is produced *into*** (Phase 32d/e) — likely the
  `ProductionOrder.destinationWarehouseId`, not the default.
- Whether `MAGASIN` stock should be excluded from the sellable quantity
  pushed to online storefronts (currently all warehouses count).
