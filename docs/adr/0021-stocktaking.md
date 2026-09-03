# ADR 0021 — Stocktaking

## Status
Accepted (2026-09-03) — Phase 32c

## Context
Phases 32a (`docs/adr/0019`) and 32b (`docs/adr/0020`) built the
warehouse-scoped inventory engine (`InventoryItem` + `InventoryMovement`,
one canonical `applyStockMovement` primitive) and stock transfers. There
was no way to reconcile the system quantity against a physical count.

Phase 32c adds stocktaking, additively — no redesign of inventory, orders,
delivery, products, finance, or RBAC.

## Decision

### 1. One session, one warehouse
`StocktakeSession` belongs to exactly one `Warehouse`
(`onDelete: Restrict`). `sessionNumber Int @unique @default(autoincrement())`,
displayed `INV-000123` (`formatStocktakeNumber`). Lifecycle
(mirrors `ORDER_STATUS_TRANSITIONS`):

```
EN_COURS --finalize--> CLOTURE   (terminal)
EN_COURS --cancel----> ANNULE    (terminal)
```

No other session states. A partial unique index
(`stocktake_sessions_one_open_per_warehouse` — raw-SQL migration) enforces
**at most one `EN_COURS` session per warehouse** at a time.

### 2. Snapshot at creation — stock is NOT frozen
`createStocktakeSessionAction` snapshots **every** existing `InventoryItem`
in the warehouse (including zero on-hand rows) into `StocktakeLine` rows,
each carrying `systemQuantityAtCount = InventoryItem.quantityOnHand` at
that instant. It never manufactures an `InventoryItem`. Product-backed and
variation-backed items are handled identically — the line references
`inventoryItemId`, which is already the `(warehouse, product|variation)`
unit.

Counting writes only `StocktakeLine` columns. `InventoryItem.quantityOnHand`
is untouched until finalization. Items added to the warehouse *after*
session creation are not part of that session (a follow-up session covers
them).

`StocktakeLine.inventoryItemId` is `onDelete: Cascade` — a deleted
product/variation takes its stock history (movements **and** stocktake
lines) with it, consistent with `InventoryMovement.inventoryItemId`.

### 3. Count updates
`updateStocktakeCountsAction` — bulk `{ lineId, countedQuantity }` entries.
`countedQuantity` is an integer ≥ 0 or explicit `null`. **`null` means
"clear the count"** (the line reverts to uncounted and is skipped at
finalize; it is also how an operator abandons a stale line). `null` is
**never** coerced to 0 (the Zod `.nullable()` sits outside the `coerce`).

Every count entry re-captures `systemQuantityAtCount` from the
**authoritative current on-hand** server-side and clears `isStale`. Client
-supplied `warehouseId` / `inventoryItemId` / `systemQuantityAtCount` /
`variance` / `movementId` are never trusted — the action resolves the line
by `{ id, stocktakeSessionId }` (IDOR guard) and reads the item quantity
itself. The session row is locked `FOR UPDATE` for the duration, so a
concurrent finalize/cancel serializes. No audit event per count.

### 4. Finalize — snapshot + stale detection + concurrency
`finalizeStocktakeSession` (service) is **two transactions**:

- **Phase 1** (own tx, no status change, no movements): lock the session
  `FOR UPDATE`, verify `EN_COURS`, lock the counted lines' `InventoryItem`
  rows `FOR UPDATE`, compare each locked current on-hand to its
  `systemQuantityAtCount`, and **persist `isStale`** (true on drifted
  lines, false on fresh ones). If any stale → throw `StocktakeStaleError`
  (session untouched, zero movements). Persisting the flag lets the UI
  list the lines to recount after a blocked finalize.
- **Phase 2** (own tx, atomic): conditional gate
  `updateMany({ where: { id, status: "EN_COURS" }, data: { status: "CLOTURE", closedById, closedAt } })`
  → `count === 0` throws `StocktakeConflictError`. Re-lock the counted
  lines' items `FOR UPDATE` and **re-verify freshness** (covers a mutation
  landing between phase 1 and 2 — if so the whole phase-2 tx rolls back,
  session returns to `EN_COURS`, zero movements). Then per counted line
  apply the signed variance `countedQuantity - currentQuantity` (for a
  fresh line `currentQuantity === systemQuantityAtCount`) through
  `applyStockMovement` (`type: INVENTAIRE`, `warehouseId` explicit,
  `stocktakeSessionId` set, `reason: "Inventaire INV-000123"`), persisting
  `appliedMovementId` on the line. **Zero variance → `appliedAt` set, NO
  movement.** Uncounted lines are skipped entirely. One `stocktake.closed`
  audit after commit.

No advisory lock — `SELECT … FOR UPDATE` (the `createRefundAction`
pattern) + conditional `updateMany` gate, both established.

**Concurrency / idempotency:**
- finalize vs finalize → the phase-2 status gate lets exactly one close;
  the other rolls back with zero movements.
- retry after successful commit → session is `CLOTURE`, gate matches 0
  rows → rejected ("déjà clôturé").
- retry after a rolled-back attempt → phase 2 is atomic, nothing persists,
  a clean retry finalizes.
- concurrent stock movement → phase-1/phase-2 locked re-check flags the
  line stale → finalize blocked (or the movement queues behind finalize
  and applies after). Never a double-count.
- `StocktakeLine.appliedMovementId` is `@unique` — a secondary DB guard
  that one movement binds at most one line.

### 5. Null / partial counting semantics
- **uncounted** (`countedQuantity IS NULL`): skipped at finalize,
  `appliedAt` stays null — a permanent "not counted in this session"
  record. Partial sessions close normally.
- **zero variance** (`counted === system === current`): `appliedAt` set,
  no movement, `appliedMovementId` null.
- **non-zero variance, fresh**: `INVENTAIRE` movement, `appliedAt` +
  `appliedMovementId` set.
- **stale**: cannot reach `CLOTURE`; resolved by recounting (which
  refreshes `systemQuantityAtCount`) or by clearing the count.

### 6. Cancellation
`cancelStocktakeSessionAction` — conditional
`updateMany({ where: { id, status: "EN_COURS" }, data: { status: "ANNULE" } })`.
No `cancelledAt`/`cancelledById` column — the `stocktake.cancelled` audit
event carries actor + timestamp (same as a transfer `ANNULE`). No stock
touched; counts kept for reference. Concurrent cancel/finalize → exactly
one wins; the loser is rejected.

### 7. Movements
New `InventoryMovementType.INVENTAIRE`. `InventoryMovement.stocktakeSessionId`
(nullable, `onDelete: SetNull`) — set only on `INVENTAIRE` rows, mirrors
`stockTransferId`. `applyStockMovement` gained `stocktakeSessionId?` and
persists it verbatim; no behavioural change for any existing caller.
Movements stay append-only. `@@index([stocktakeSessionId])`.

### 8. RBAC
New permission `inventory.count`, granted to OWNER, ADMIN, MANAGER,
WAREHOUSE (counting is warehouse-floor work — matches `inventory.adjust` /
`inventory.transfer`). Viewing `/inventaires` + `/inventaires/[id]` uses
`inventory.view`. Every mutation requires `inventory.count` server-side;
the actor is always the authenticated user, never a payload value.

### 9. Audit
`stocktake.created` / `stocktake.closed` / `stocktake.cancelled` — one
event per lifecycle action. `stocktake.closed` metadata carries
`{ sessionNumber, appliedCount, zeroVarianceCount, uncountedCount, movementCount }`.
No per-count audit event.

### 10. UI / routes
`/inventaires` (list), `/inventaires/nouveau` (pick active warehouse +
notes), `/inventaires/[id]` (count table for `EN_COURS`; read-only
variance/adjustment table for terminal states; a banner lists stale lines
and states that finalize is blocked). Sidebar "Catalogue" group gains
"Inventaires" (`inventory.view`). Reuses `PageHeader`, `StatusBadge`,
`DataTablePagination`, `EmptyState`, `Table`, `Select`, `Card`,
`AlertDialog`, toast conventions.

## Consequences
- Fully additive: 630 pre-existing tests unchanged; the migration touches
  no existing data (`stocktakeSessionId` is born nullable, no backfill).
- A warehouse with stocktake history can no longer be deleted
  (`onDelete: Restrict`) — it holds `InventoryItem` rows anyway.
- Finalize can be blocked indefinitely if stock keeps moving on a counted
  line — by design; the operator recounts.

## Explicitly NOT in this phase
No inventory freezing, no `quantityInTransit`, no new stock buckets, no
batch/lot/serial, no barcode/RFID, no bins/zones, no automatic
replenishment, no procurement, no production, no accounting / COGS /
inventory-valuation changes, no finance mutation, no delivery or product
-editor changes, no reporting dashboard / export.
