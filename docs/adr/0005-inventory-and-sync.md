# ADR 0005 — Inventory model and stock movement rules

## Status
Accepted (2026-08-21)

## Context
Inventory must support incoming/sold/reserved/damaged/returned quantities,
manual adjustments with full history, low-stock alerts, and — per the
brief — eventual two-way sync with WooCommerce/Shopify that must never
silently overwrite external inventory. This phase builds the internal
inventory engine; the external-sync half is deferred (see
`docs/adr/0004-integration-architecture.md`).

## Decision

### Two tables: current-state cache + append-only ledger
- `InventoryItem` — one row per (warehouse, product) or (warehouse,
  variation). Holds `quantityOnHand`, `quantityReserved`,
  `quantityDamaged`. This is what list/detail pages read — fast, no
  aggregation needed.
- `InventoryMovement` — append-only. Every change to `InventoryItem` goes
  through `src/lib/inventory.ts`'s helpers in the same database
  transaction as the corresponding `InventoryItem` update, so the two can
  never drift. `InventoryMovement.type` (`RECEPTION` / `VENTE` / `RETOUR` /
  `ENDOMMAGE` / `AJUSTEMENT_POSITIF` / `AJUSTEMENT_NEGATIF` /
  `RESERVATION` / `LIBERATION`) records *why* a quantity changed, not just
  the delta.

### Order lifecycle drives stock automatically; see `src/lib/inventory.ts`
1. **Order created** → `reserveStockForOrder`: `quantityReserved` +=
   quantity, `quantityOnHand` untouched. The item isn't gone from
   sellable stock, but it's spoken for.
2. **Order → EXPEDIEE** → `fulfillStockForOrder`: `quantityOnHand` -=
   quantity, `quantityReserved` -= quantity. This is the only point stock
   actually leaves the warehouse in the model.
3. **Order cancelled before shipment** (`shippedAt` still null) →
   `releaseStockForOrder`: `quantityReserved` -= quantity,
   `quantityOnHand` untouched — nothing was ever actually removed.
4. **Order cancelled/failed after shipment**, or moved to `RETOUR` →
   `returnStockForOrder`: `quantityOnHand` += quantity — goods physically
   came back to the warehouse.
5. **EXPEDIEE → ECHEC does not, by itself, move stock.** A failed-in-transit
   package is ambiguous (still out, or already returned?) — the model
   doesn't guess. Staff reconcile via a manual inventory adjustment
   (`inventory.adjust` permission) once the physical outcome is known, or
   the order continues to `ANNULEE`/`RETOUR` which does trigger the
   appropriate movement per the rules above.

Every one of the branches above is implemented and covered by
`tests/actions/orders.test.ts`.

### Manual adjustments
`adjustInventoryAction` requires `inventory.adjust`, a non-empty `reason`
(never a silent adjustment), and rejects any adjustment that would drive
`quantityOnHand` negative. `ENDOMMAGE` additionally increments
`quantityDamaged` so damaged stock is visible separately from a plain
negative adjustment (e.g. inventory recount).

### Warehouses
`Warehouse` and per-warehouse `InventoryItem` rows exist; one default
warehouse ("Entrepôt principal") is seeded. Choosing *which* warehouse
fulfills a given order when more than one exists is not implemented — see
`docs/adr/0002-domain-model.md`'s deferred section.

## Audit addendum (2026-08-21 A–G pre-integration hardening)
Two hardening fixes came out of the pre-integration audit, both closing
races rather than changing the model above:

1. **DB-level "exactly one of productId/variationId" constraint.** Nothing
   previously stopped application code from creating an `InventoryItem`
   with both FKs set or neither, which would corrupt `applyMovement`'s
   `findFirst` lookup (matching the wrong row, or none). Prisma 6.19.2's
   schema DSL can't express a multi-column CHECK, so this is enforced via a
   raw-SQL migration
   (`prisma/migrations/20260821020000_inventory_item_exactly_one_ref_check`)
   as defense-in-depth beneath the two application code paths
   (`createProductAction`, `createProductVariationAction`) that already
   only ever set one.

2. **Negative-stock race in `applyMovement`.** The stock-decrement check
   was originally a pre-transaction read-then-compare, which two concurrent
   requests could both pass before either committed, driving
   `quantityOnHand` negative. Fixed by applying the `increment` first, then
   checking the *post-update* row inside the same transaction and throwing
   (rolling back) if it went negative — Postgres's row lock during the
   `UPDATE` itself is what closes the race, not the application check.
   `quantityReserved` going negative (which can only arise from prior data
   drift, not this code path) is defensively clamped to 0 rather than
   treated as a hard error. Verified by a genuine `Promise.all([...])`
   concurrency test in `tests/actions/inventory.test.ts`.

## Deferred (explicitly, not silently)
- **Two-way sync with WooCommerce/Shopify inventory.** The brief is
  explicit that this must never silently overwrite external inventory
  when built. No sync exists yet, so the question doesn't arise — but the
  conflict-handling policy (last-write-wins? external-is-source-of-truth
  for received stock, internal-is-source-of-truth for reservations?) needs
  an explicit decision before that adapter is built, not an assumption
  baked in now.
- **Multi-warehouse fulfillment routing.**
- **Automatic reorder points / purchase order generation.** Low-stock
  alerting (via `Product.lowStockThreshold` and the Stock page's low-stock
  filter) exists; automatically generating a reorder does not.
