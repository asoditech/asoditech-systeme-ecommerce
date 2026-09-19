# ADR 0038 — Online + Offline unification: channels, catalog identity, barcodes, ledger hardening

## Status
Accepted (2026-09-19). Additive on top of ADR 0019/0020/0021/0036/0037 — it
extends the inventory and order architecture, it does not replace any of it.
Companion ADRs: 0039 (authorization: permission overrides + channel scope) and
0040 (offline sales, suppliers/receptions, reporting).

## Context
The system was an Online (delivery) back office with a working, multi-location
inventory engine: `InventoryItem` per `(Warehouse, product|variation)`, one
canonical stock writer (`applyStockMovement`), an append-only-by-convention
`InventoryMovement` ledger, transfers, stocktakes, physical returns, location
access control, and tenant RLS. The business now also sells in physical
stores. A read-only audit (see the 2026-09-19 architecture report) found:

- no barcode anywhere; SKU unique per table only (a product SKU and a variation
  SKU could collide);
- no notion of a business channel — "online = ENTREPOT" was a hardcoded rule
  inside the WooCommerce stock push;
- `Category` existed and was tenant-scoped but had no UI (`createCategoryAction`
  was never called) — categories only arrived via sync;
- ledger holes: no signed delta / running balance / cost; a never-sold product
  could be hard-deleted, cascading away its whole stock history; deleting a
  user nulled `performedById`, erasing who moved stock.

## Decision

### The frozen principle
**ONE catalog + ONE physical stock + ONE immutable ledger + MULTIPLE business
channels + SEPARATE transaction types.** Inventory ≠ availability:

- *Inventory* answers "how much physical stock exists, and where?" — it belongs
  to physical **Locations** (`Warehouse`), exactly as before.
- *Availability* answers "where may this product be sold?" — it belongs to
  **channels**.

There is **no** `OnlineStock` / `OfflineStock` / per-channel quantity anywhere,
and the schema has nowhere to put one (a test asserts the channel tables carry
no quantity-like column). Channel stock is always *derived* from the physical
locations a channel is mapped to.

### `SalesChannel` is not a `Warehouse`
`SalesChannel { tenantId, name, kind ONLINE|OFFLINE, isActive, isDefault, metadata }`
is a business *activity* (Website WooCommerce, Shopify, Store Casablanca…).
`Warehouse` stays the only physical-location entity (ADR 0019/0037 rejected a
second one) and gains **no** ONLINE/OFFLINE `WarehouseType` — `ENTREPOT` /
`MAGASIN` remain purely physical. `SalesChannelLocation(channel, warehouse)` is
a pure mapping: which locations a channel sells/fulfils from. A location may be
mapped to several channels (a shared pool — see "Shared locations").

### What is deliberately UNCHANGED
- `applyStockMovement` is still the only writer of movement rows; the order
  lifecycle (reserve at CONFIRMEE, fulfil only at EXPEDIEE, one-way push,
  physical returns) is untouched.
- **The WooCommerce/Shopify stock push keeps its own type-based rule** (active
  `ENTREPOT` → WooCommerce, Shopify-source locations → Shopify). The channel
  mapping is *seeded to mirror it exactly*, and a newly created ENTREPOT /
  Shopify Location is auto-mapped to the default ONLINE channel so the two stay
  consistent. Later edits to a location's type/active flag are **not** re-synced
  — from then on the mapping is explicit channel configuration
  (`/parametres/canaux`). Rewiring the push to read the mapping is a possible
  later step, deliberately not taken here (it would change a live sync path).
- Order lifecycle semantics, revenue recognition (`REVENUE_EXCLUDED_STATUSES`,
  `placedAt`), commissions, delivery — untouched.

### Catalog identity
- **One catalog.** No `OnlineProduct`/`OfflineProduct`. `ProductSalesChannel
  (product, channel)` records "may be sold on this channel" — availability
  only. Variations inherit their product's availability. A product may be
  Online-only, Offline-only, or both, without duplication.
- **Reference vs SKU.** `Product.reference` is the free-form *model/family*
  reference ("SKOUBA"); `sku` stays the unique sellable-unit reference on both
  `Product` and `ProductVariation`. `reference` is not unique (many products
  share a model) and is searchable.
- **Sellable unit** = a simple `Product`, or one `ProductVariation` — never a
  variable parent (its stock lives on its variations). This is exactly the
  `InventoryItem` product-XOR-variation invariant, unchanged.
- **Ownership (ADR 0017).** Reference, barcodes and channel availability are
  ASODITECH-owned — like `cost`/`trackInventory` — so they stay editable on a
  synced product and no sync ever writes them. Name/SKU/price/category of a
  synced product remain provider-owned. **Category ownership on synced products
  is unchanged**: the sync still owns `categoryId` for a synced product; the
  ambiguity (an operator may want an internal category different from the
  store's) is documented, not "fixed" with a destructive sync policy.
- **Offline-only products with a store connected.** ADR 0017 hid the native
  product form whenever a store was connected. A product sold *only* in a
  physical store has no platform to be created on — it is a native (`INTERNE`)
  product, which 0017 never forbade (it only stops ASODITECH editing a *synced*
  product). `/produits/nouveau` therefore keeps its "create on the platform"
  cards **and** offers a store-only form, restricted to OFFLINE channels.
- **Categories** are real, tenant-scoped, hierarchical entities (unchanged
  schema). New: inline creation from the product form (slug derived), and the
  existing category filter/report dimension keep working.

### Barcode model
`Barcode { tenantId, code, productId XOR variationId, isPrimary }` — its own
table so that uniqueness is **per tenant across both owner kinds**, which two
per-table columns could not guarantee. DB-enforced: `UNIQUE(tenantId, code)`,
an XOR CHECK on the owner, and two partial unique indexes (one primary per
unit). Multiple codes per unit are supported (internal EAN + supplier EAN +
aliases). Codes are **opaque**: nothing parses a code; size/colour come from
the variation's `attributes`, never from a barcode string. A barcode on a
variable parent is refused (it belongs on each variation).

**Lookup priority** (`src/lib/catalog/lookup.ts`): barcode (exact, must resolve
to exactly one unit; an unsellable exact code does *not* fall through to a fuzzy
match) → reference/SKU (exact, case-insensitive, may be ambiguous — all matches
returned) → partial name / model reference / SKU / variation SKU. A variable
parent is expanded into its variations. The product list, order-form picker and
global search share one predicate (`productSearchWhere`) so all three find a
product by variant SKU, barcode or reference.

**Cross-table uniqueness (SKU).** `sku` is unique per table only; a database
cannot express "unique across two tables" without a shared registry. Chosen:
**application-level validation** — a new SKU may not equal another unit's SKU
(product↔variation) or any barcode; a barcode may not equal another unit's SKU
— plus the scan lookup's deterministic priority. *Documented limitation:* SKUs
written by a WooCommerce/Shopify import are not re-checked against barcodes (a
sync must never fail on identity a merchant added locally).

### Ledger hardening (no second ledger)
`InventoryMovement` gains **nullable** columns: `onHandDelta` (signed effect),
`onHandAfter` (running balance), `unitCost`, `performedByName` (actor snapshot),
and — with their tables — `receptionLineId`, `saleId`, `saleReturnId`. One
nullable FK per source document, matching the existing `stockTransferId` /
`stocktakeSessionId` / `orderReturnId` precedent (referential integrity), not a
polymorphic `sourceType/sourceId`. `applyStockMovement` fills the new columns
for every movement written from now on.

- **Traceability starts at the cut-over.** Movements written before this change
  keep `NULL` deltas/balances/costs and no source document; nothing is
  reconstructed or invented. Stock created at onboarding by
  `reconcileStockFromProvider` (an `InventoryItem` with a quantity and no
  movement) still has no opening movement — the ledger for those rows does not
  sum to on-hand, and this ADR does not paper over that.
- **History survives deletes.** `removeProductAction` now *archives* (instead of
  hard-deleting) any product that has a stock movement on itself or on a
  variation — previously only products with order lines were archived, and the
  ledger cascaded away with a never-sold product. The WooCommerce bogus-duplicate
  cleanup applies the same guard. Deleting a user snapshots their name onto the
  movements they performed before the FK goes null.
- **Available-stock guard (opt-in).** `applyStockMovement({ enforceAvailable })`
  additionally rejects a movement that would leave `onHand < reserved`. Default
  `false` → the order lifecycle behaves exactly as before (fulfilment consumes
  its *own* reservation). An offline sale passes `true` so it can never consume
  units reserved for a confirmed online order.

### Shared locations
A location mapped to two channels is a shared pool. With `enforceAvailable`,
an offline sale can only consume `onHand − reserved`, so it cannot take units a
confirmed online order holds; the online order's later EXPEDIEE therefore
cannot fail for that reason. What this does **not** provide is channel-specific
logical allocation (e.g. "reserve 30 for the store"): first-come pool
semantics. That is a documented future extension; the recommended v1 is one
location per channel.

### Migration & backfill (expand → backfill → verify; no contract step)
`20260919100000_online_offline_foundation`, additive only. Backfill, all
deterministic and idempotent (`ON CONFLICT DO NOTHING`, ids derived from the
row): one default ONLINE channel per tenant; mapped to active ENTREPOT +
Shopify-source locations (never MAGASIN); every existing order attributed to it
(every order to date is a delivery order); every existing product available on
it; every non-OWNER/ADMIN user assigned to it (they could already see the
delivery business). `Order.salesChannelId` stays nullable — a `NULL` (e.g. an
order restored from a pre-channel backup) is visible to OWNER/ADMIN only, never
guessed. Every new tenant-scoped table is registered in `BACKUP_MODELS` (which
also drives tenant deletion), gets RLS, and is covered by the test reset helper.

**Restoring a pre-channels backup** replaces the new tables with empty ones
(a restore is a point-in-time snapshot). `ensureDefaultOnlineChannel()`
self-heals the default channel on the next order; per-user channel assignments
(not part of a backup, like `UserLocation`) are cascade-cleared with the
channels and must be re-assigned by an admin.

## Consequences
- The current online business behaves identically: every order/product/user was
  backfilled onto the default ONLINE channel, and the stock push is unchanged.
- A tenant that never creates an OFFLINE channel sees no functional change
  beyond identity fields (reference, barcodes) and inline category creation.
- More tables to keep in step (backup registry, reset helper, RLS) — the price
  of first-class channels; each is covered by the RLS verification below.

## Verification of RLS on the new tables
The local superuser bypasses RLS, so isolation was verified as the local
non-superuser role `asoditech_app` (`SET ROLE`): no GUC ⇒ 0 rows; another
tenant's GUC ⇒ 0 rows; a cross-tenant INSERT is rejected by `WITH CHECK`.
`scripts/verify-rls.sh` remains the check to run against any real deployment.

## Addendum — business mode (ADR 0041)
Everything Offline-era in this ADR (channels beyond the default Online one, product↔channel availability, barcodes/reference/categories UI and actions, the Online/Offline/Total report) is a *capability* that is only active for tenants whose `businessMode` is `ONLINE_AND_OFFLINE`. For `ONLINE_ONLY` tenants the schema and the ledger hardening still apply (they are invariants, not features), but the surfaces are closed server-side. See `docs/adr/0041-tenant-business-mode.md`.
