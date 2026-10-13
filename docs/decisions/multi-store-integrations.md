# Decision required — several WooCommerce / Shopify stores per company

Status: **not implemented, design not final** (reviewed 2026-10-12). Today a
company can connect ONE WooCommerce store and ONE Shopify store. Multi-store
is a future capability: this note records the agreed direction, what
supporting several stores would change, and the decisions still open. It is
not an implementation plan that has been approved.

## Agreed direction (confirmed by the owner)

- **Products are shared centrally.** A company has ONE catalogue in
  ASODITECH. The same central product or variation can be listed in several
  connected stores; a store does not get its own copy of the product.
- **Stock is shared centrally, and ASODITECH stays the source of truth.**
  This is unchanged from ADR 0036: `InventoryItem` is the only authority,
  store stock is one-way downstream (ASODITECH → store), and a store's
  reported quantity may only initialize a row ASODITECH has never seen.
  Adding stores adds more downstream targets; it never adds a second ledger.
- **Multi-store is future work.** Nothing below is built; no schema or code
  change was made for it.

Everything else in this note is a proposal or an open question.

## Why it is not a small change

| Today | Where | Consequence for several stores |
| --- | --- | --- |
| `Integration @@unique([tenantId, provider])` | `prisma/schema.prisma` (model Integration) | A second WooCommerce row is impossible. |
| Every action / card reads `findFirst({ provider })` | `src/actions/woocommerce.ts`, `shopify.ts`, `integrations.ts`, cards | No way to say WHICH store to sync. |
| No link Integration → `SalesChannel` | orders land on the default ONLINE channel (`getDefaultOnlineChannelId`, `src/lib/channels.ts`) | Orders of store A and B would be mixed in one channel. |
| One webhook URL per provider; the tenant is found by trying each stored secret | `src/app/api/webhooks/woocommerce/route.ts` | Works per tenant, but cannot tell store A from store B of the same tenant if they share a secret. |
| `Order @@unique([tenantId, source, externalId])` | schema (model Order) | Two WooCommerce stores both have an order #1001 → the second is treated as the first (wrong update / skipped). |
| `Product` / `ProductVariation` carry ONE `(source, externalId)` pair (indexed, not unique; uniqueness comes from the identity resolution in `src/lib/integrations/shared/identity.ts`, ADR 0055) | schema, `identity.ts` | A central product can hold only one store identity. Store B's id for the same product has nowhere to go; ADR 0055's SKU adoption only considers products that are still unlinked (`INTERNE`), so a product already linked to store A would be re-created as a duplicate for store B. |
| `ProductPublication @@unique([tenantId, productId, provider])`, product-level only | schema, `src/actions/product-publishing.ts` | One publication per provider, and no variation-level row. |
| Shopify locations become `Warehouse` rows matched by `(source = SHOPIFY, externalId = location gid)` | `src/lib/integrations/shopify/sync/locations.ts` | Two Shopify stores' location ids would need to be told apart per connection. |
| Stock push, sync cursors and leases keyed per provider | `sync/stock-push.ts` (both providers), `Integration.config` | Need to become per connection. |
| Per-connection choices in `Integration.config` (`remoteDeletionMode`, `inventoryOwner`, order-history and first-import options), kept on a same-address re-save | `store-settings.ts`, `src/actions/integrations.ts` | Each store would carry its own; who owns the stock could then differ per store. |

## Proposed design (if approved — not final)

### 1. Connections
- `Integration` becomes a *connection*: add a display `name` and a
  `salesChannelId`; drop `@@unique([tenantId, provider])` in favour of a
  per-connection key (exact key depends on open decision D4 below).
- Every action takes an `integrationId`, checked server-side against the
  caller's tenant (never trusted from the client alone).
- Webhooks: one URL per connection
  (`/api/webhooks/woocommerce/<connection token>`); the token resolves the
  connection directly, and the signature is still checked with that
  connection's own secret.

### 2. Products: per-connection link model (replaces the earlier proposal)
The earlier version of this note proposed scoping `Product` /
`ProductVariation` external ids by integration (one `integrationId` +
`externalId` on the product row). **That is insufficient with a shared
catalogue**: one central product listed in two stores has two external ids
at the same time, which a single column cannot hold.

Proposed instead — a link table per connection, the product rows stay
central:
- **Product link** (an evolution of `ProductPublication`): one row per
  `(integrationId, productId)` holding that store's product id, unique on
  `(tenantId, integrationId, externalId)` and on
  `(tenantId, integrationId, productId)`.
- **Variation link** (new): one row per `(integrationId, variationId)`
  holding that store's variation / variant id (and, for Shopify, whatever
  per-variant id the stock push needs), with the same two unique keys.
- Identity resolution (ADR 0055) would look up these links per connection
  instead of `Product.source/externalId`; its order of resolution (linked →
  publication → SKU) would need to be re-specified per connection.
- `Product.source/externalId` would remain for history/origin only, or be
  retired after a backfill — open (see D6).

### 3. Orders
- `Order.integrationId` added; the order key becomes
  `(tenantId, integrationId, externalId)` after the backfill.
- The order's channel follows its connection's sales channel (see D4).

### 4. Stock
- Today the pushed number is sellable stock (`quantityOnHand -
  quantityReserved`): for WooCommerce, summed across active ENTREPOT
  warehouses (`onlineSellableStock`, `woocommerce/sync/stock-push.ts`); for
  Shopify, each linked location's own sellable quantity
  (`shopify/sync/stock-push.ts`). With several stores it would be pushed to
  each connection through its variation links.
  How the shared quantity is presented to each store is open (D3).

### 5. UI
- One card per connection, with its channel, status, cursors, history
  toggle and webhook health.

## Open decisions (no answer recorded yet)

- **D1 — Matching an imported product when SKUs match.** When store B
  imports a product whose SKU matches a central product already linked to
  store A: link it to the existing central product, create a new product,
  or ask a person? What if variation SKUs only partly match?
- **D2 — Conflicts across stores.** When store A and store B report a
  different name, price, description or image for the same central product,
  which one (if any) updates the central product? Are prices per store?
- **D3 — Stock sent to each store.** Does every store receive the same full
  available quantity (risk: overselling when two stores sell the last unit
  at once), a per-store allocation, or a buffer? Which warehouses feed which
  store?
- **D4 — Sales channel per connection.** Must every connection have its own
  sales channel (the earlier proposal said yes), may several connections
  share one, and what happens to existing orders on the default ONLINE
  channel?
- **D5 — Order numbering in the UI.** Keep ASODITECH's own `CMD-…` numbers
  only, or also show / search by each store's own order number, with the
  store name?
- **D6 — Backfill and constraint migration strategy.** How existing rows
  (`Product/ProductVariation.source/externalId`, `ProductPublication`,
  `Order`, Shopify `Warehouse` rows, `Integration.config` cursors) are
  attached to the current single connection, and in which order the
  constraints are swapped. Required either way: additive migration first,
  the backfill verified on a **copy** of production data, and only then the
  constraint swap — never directly on Production.

## Prerequisites for any future implementation (not done)

- Business answers to D1–D6, then a final design (an ADR superseding the
  relevant parts of ADR 0010, 0011 and 0055).
- Migration review: additive migration(s), backfill, constraint swap, each
  verified on a database copy; confirm where Preview's database points
  before pushing, since a push runs `migrate deploy`.
- Grant review: any new table needs the runtime role's privileges and RLS
  policy, checked with `scripts/prod-check-runtime-role.sql`.
- Tests: full regression of the WooCommerce and Shopify suites; new tests
  for per-connection identity resolution (no duplicate and no cross-store
  link), per-connection order idempotency, per-connection webhooks, stock
  push to several stores, and tenant isolation of connections.
- A live test with two development stores per provider.

## Until then

One store per provider. A company with two WooCommerce shops can connect
only one of them.
