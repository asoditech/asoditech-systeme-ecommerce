# ADR 0020 — Stock transfers + order fulfilment warehouse

## Status
Accepted (2026-09-03) — Phase 32b

## Context
Phase 32a (`docs/adr/0019-inventory-foundation.md`) made `InventoryItem`
strictly warehouse-scoped, added `Warehouse.type` (ENTREPOT/MAGASIN) +
`isActive` + minimal CRUD, and routed every stock mutation through the one
canonical primitive `applyStockMovement(tx, input)`. It deliberately did
**not** add a way to move stock between locations, nor a way for an order
to say which location fulfils it — `resolveOrderStockWarehouseId` guessed
(default warehouse → the product's single row → default/no-op).

Phase 32b adds both, additively — no redesign of the order, delivery,
product, finance, or integration architecture.

## Decision

### 1. `Order.fulfillmentWarehouseId` (nullable)
- Set at creation to `getDefaultWarehouseId()`, or to an operator-selected
  **active** warehouse (an active MAGASIN is a legitimate choice for a
  walk-in / internal order — only "exists + isActive" is enforced on an
  override; the default is trusted verbatim).
- Creation-time only. There is **no** post-creation warehouse-change
  action in 32b (an already-shipped order's reservation→fulfilment has
  already consumed stock at the recorded location).
- `null` for pre-32b orders (and for a broken deployment with no default
  warehouse) → the pre-32b compatibility resolution in
  `resolveOrderStockWarehouseId` applies unchanged.
- `onDelete: SetNull` (matches `campaignId`/`createdById`); the
  `InventoryMovement.warehouseId` rows carry the authoritative record.
- Added to the `order.created` audit metadata.
- `applyOrderLines` reads it once inside the caller's transaction and
  passes it as `preferredWarehouseId` — the four public order stock
  helpers keep their signatures.

### 2. `getDefaultWarehouseId(client = prisma)`
`src/lib/inventory.ts`, tx-aware, returns `string | null`. The single
source of truth for "which warehouse a new record's stock defaults to".
Callers: `createProductAction`, `createProductVariationAction`,
`resolveOrderStockWarehouseId`/`applyOrderLines`, `createOrderAction`.

### 3. `StockTransfer` + `StockTransferLine` + `TransferStatus`
Lifecycle (mirrors `ORDER_STATUS_TRANSITIONS`):

```
BROUILLON --dispatch--> EN_TRANSIT --receive--> RECU   (terminal)
BROUILLON --cancel----> ANNULE                          (terminal)
```

- `transferNumber Int @unique @default(autoincrement())`, displayed
  `TR-000123` (`formatTransferNumber`) — same pattern as `Order.orderNumber`.
- Source and destination must differ — DB CHECK
  `stock_transfers_source_ne_destination_check`.
- Creation requires **both** warehouses active. Source/destination are
  immutable after creation; a BROUILLON draft edits only lines + notes.
- **Dispatch** does not re-check the source's active flag (drain a
  location, then retire it). **Receive** does re-check the destination is
  active (you can't push stock into a dead location).
- No reservation system, no split fulfilment, no auto-routing, no
  in-transit stock bucket.
- `StockTransferLine`: exactly one of `productId`/`variationId` at the
  **application** level (mirrors `OrderItem`) — no XOR DB CHECK, because
  `onDelete: SetNull` on the catalogue FKs would make it fail the moment a
  product is deleted. External-source (SHOPIFY/WOOCOMMERCE) products **are**
  allowed in transfers — transfer scope is inventory, not catalogue
  editing. DB CHECK `stock_transfer_lines_quantities_check`:
  `quantitySent > 0 AND (quantityReceived IS NULL OR 0 <= quantityReceived <= quantitySent)`.

### 4. Movements
- New `InventoryMovementType` values `TRANSFERT_SORTIE` (source, on
  dispatch) and `TRANSFERT_ENTREE` (destination, on receive).
- `InventoryMovement.warehouseId` **NOT NULL** — every movement has always
  been applied to an `InventoryItem` (`inventoryItemId` NOT NULL, onDelete
  Cascade → no orphan possible), so the backfill from
  `inventory_items.warehouseId` was total. Hand-written migration:
  add nullable → deterministic backfill → verify zero NULLs (raises) →
  `SET NOT NULL` → FK. Indexes `@@index([warehouseId, createdAt])` and
  `@@index([stockTransferId])`.
- `InventoryMovement.stockTransferId` (nullable, `SetNull`) on the two
  TRANSFERT_* rows. `applyStockMovement` now persists `item.warehouseId`
  on every movement and accepts `stockTransferId`.

### 5. `ensureInventoryItem(tx, { warehouseId, productId?, variationId? })`
`src/lib/inventory.ts`. Get-or-create via `upsert` on the existing
compound unique — concurrency-safe, no advisory lock. `variationId` wins
when both refs given; "neither" throws. Never creates a
Product/ProductVariation. No `isActive` enforcement inside it.

### 6. Dispatch / receive services (`src/lib/transfers.ts`)
Each is ONE transaction: conditional `updateMany({ where: { id, status } })`
+ row-count gate (the concurrency guard, same as order/shipment status
transitions), then per-line `applyStockMovement`.

- **Dispatch**: any insufficient stock OR missing source `InventoryItem`
  fails the whole transaction — no partial dispatch, status stays
  BROUILLON.
- **Receive**: partial allowed; `ensureInventoryItem` for missing
  destination rows; a shortfall (`received < sent`) is recorded only on
  `quantityReceived` — stock is never returned to the source, no extra
  movement (the ledger already shows the loss as the `SORTIE` −
  `ENTREE` delta). `quantityReceived = 0` is valid. A line whose
  catalogue record was deleted (both refs null) is skipped safely.

### 7. RBAC
New permission `inventory.transfer`, granted to OWNER, ADMIN, MANAGER,
WAREHOUSE (moving stock between locations is operational work, unlike
`warehouses.manage`). Viewing the transfer list/detail uses
`inventory.view`; every mutation requires `inventory.transfer`
server-side. The actor is always the authenticated user, never a payload.

### 8. Audit
`stock_transfer.created` / `.dispatched` / `.received` / `.cancelled` —
one event per lifecycle action; the `InventoryMovement` rows are the
line-level evidence. A draft edit records no audit event.

### 9. WooCommerce online stock → active-ENTREPOT only
`pushStockToWooCommerce` now filters the sellable computation to
`warehouse.type = ENTREPOT AND isActive` (`onlineSellableStock`). A
WooCommerce product with inventory rows but **zero** active-ENTREPOT stock
(everything at a MAGASIN, or only at a retired ENTREPOT) is pushed as
**`0`** — never skipped and left stale. A product with no inventory row at
all is still skipped (pre-32b behaviour preserved). Variation-level push
follows the same rule.

**Shopify is unchanged** — `pushStockToShopify` scopes by
`source: SHOPIFY` warehouse + `externalId`, never by `type`; a Shopify
Location warehouse is the storefront's own fulfilment location and must
keep pushing regardless of its local `Warehouse.type`.

## Consequences
- Fully additive: 576 pre-existing tests unchanged; the migration only
  touches data for the `inventory_movements.warehouseId` backfill.
- `Warehouse` rows referenced by a transfer or a movement can no longer be
  deleted (`onDelete: Restrict`) — they hold `InventoryItem` rows anyway
  (32a); deactivate instead.
- A WooCommerce product whose stock is entirely at a MAGASIN now shows
  `0` online — deliberate (MAGASIN never feeds the storefront).

## Out of scope (later phases)
Stocktaking (32c), production domain (32d–f), procurement, BOM, raw
materials, transfer reservation, split fulfilment, auto-routing,
forecasting.
