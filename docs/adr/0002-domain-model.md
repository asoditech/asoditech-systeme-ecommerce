# ADR 0002 — Domain model and multi-tenant strategy

## Status
Accepted (2026-08-21)

## Context
This is a reusable SaaS-style e-commerce management platform, not a
single-client build. It must eventually connect to WooCommerce, Shopify,
delivery providers, ad platforms, and an AI provider, without any of those
integrations leaking into the core domain model. It must also fit into
ASODITECH's existing multi-product architecture: the sibling **Control
Center** repository already models `Client` → `Product` → `Instance` as the
unit of deployment, where each `Instance` is one running installation of a
product for one client, authenticated via a licensing key (Control Center
ADR 0004).

## Decision

### Multi-tenancy: deployment-level, not row-level
This schema has **no `tenantId` column anywhere**. Isolation between
clients happens at the deployment level — each client gets their own
`Instance` (own database, own environment, own domain), orchestrated by the
Control Center — not by scoping rows within one shared database. This
mirrors the Control Center's own domain model (ADR 0002 there): "the first
client is the first deployment, not the architecture." Reusability comes
from the codebase being generic and configurable (see
`BusinessSettings`, `ExpenseCategory.isSystem`, the RBAC permission matrix),
never from `if (client === X)` branches.

A future phase may add a licensing client (`src/lib/license/` equivalent to
Control Center's) that calls `POST /api/v1/license/verify` on startup and
periodically, using an `Instance` license key issued by the Control Center.
That boundary is deliberately not built yet — no business need for it
exists until this system has a real client deployment to license.

### Entity boundaries
- **Customer** — independent of any order; has addresses (1:N, one
  default), tags (free-form), and a `segment` enum that is **manually set
  only**. No automatic segmentation logic exists — the brief explicitly
  says not to invent calculation rules before they're defined.
- **Product / Category / ProductVariation** — generic, not a WooCommerce or
  Shopify copy. `Product.source` (`INTERNE` / `WOOCOMMERCE` / `SHOPIFY`) and
  `externalId` exist so a future adapter can map an external catalog onto
  this model without a schema change — see
  `docs/adr/0004-integration-architecture.md`.
- **Order / OrderItem** — `OrderItem` snapshots `nameSnapshot`,
  `skuSnapshot`, `unitPrice`, and `costSnapshot` at time of sale. Editing a
  product's name or cost later must never rewrite historical order/margin
  data. `Order.shippingAddress*` fields are a snapshot too, not a live FK
  to `CustomerAddress`, for the same reason.
- **Refund** — separate from `Order.paymentStatus`; an order can have
  multiple partial refunds. `paymentStatus` is set to `REMBOURSE` only once
  a `Refund` reaches `COMPLETE` (see `updateRefundStatusAction`).
- **InventoryItem / InventoryMovement** — `InventoryItem` is a current-state
  cache (one row per warehouse × product, or warehouse × variation);
  `InventoryMovement` is the append-only ledger. See
  `docs/adr/0005-inventory-and-sync.md`.
- **AuditEvent** — append-only, generic (`actorType` / `action` /
  `entityType` / `entityId` / `previousValue` / `newValue` / `metadata`
  JSON), exactly like Control Center's `AuditEvent`. No per-entity audit
  tables. Application code must never call `.update()` or `.delete()` on
  this model — `src/lib/audit.ts` is the only writer.

### Status models
Every status is a Postgres enum with an explicit, code-enforced transition
table, not free-form writes:
- `OrderStatus`: see `src/lib/validation/order.ts:ORDER_STATUS_TRANSITIONS`.
  `ANNULEE` and `REMBOURSEE` are terminal.
- `ShipmentStatus`: see
  `src/lib/validation/delivery.ts:SHIPMENT_STATUS_TRANSITIONS`. `LIVRE` and
  `ANNULE` are terminal.
- `RefundStatus`, `IntegrationStatus`, `SyncRunStatus`: simpler, enforced
  inline in their respective actions rather than a full transition table —
  their state spaces are small enough that a table would be
  over-engineering.

Every status transition on `Order` and `Shipment` is validated
server-side in the Server Action, never trusted from client input, and
every transition is written to `AuditEvent`.

### Deletion policy
No hard deletes for `Order`, `Customer`, `Product` (once it has orders),
`Refund`, `Expense` history that's been referenced, or anything financial.
Archival is status-based (`ProductStatus.ARCHIVE`, `CustomerSegment`
untouched, `Order` cancellation via status). Foreign keys from
`OrderItem`/`Refund`/`Shipment` back to `Order` use `onDelete: Restrict` or
`Cascade` only where cascading is semantically correct (deleting an Order's
items when the Order itself is deleted is fine; deleting a Customer that
has Orders is not — `Order.customerId` uses `onDelete: Restrict`).

### Money
`Decimal(12,2)` for every currency amount, never floating point. `currency`
is a validated 3-letter string, not an enum, matching Control Center's
reasoning: the set of currencies this system might invoice in isn't closed
enough to justify a migration every time it changes. Default currency is
"MAD" throughout, configurable per-order.

## Deferred (explicitly, not silently)
- **Row-level multi-tenancy.** Not needed under the deployment-per-client
  model above. If ASODITECH later decides to run multiple clients from one
  shared database instead, that's a deliberate future migration adding a
  `tenantId` column and scoping every query — not something to bolt on
  incrementally.
- **Automatic customer segmentation.** `Customer.segment` exists and is
  manually settable; the rules for computing "Client à risque" etc.
  automatically are not defined yet (see project brief §8) and therefore
  not implemented.
- **Multi-warehouse allocation logic.** `Warehouse` and
  `InventoryItem.warehouseId` exist and a single default warehouse is
  seeded; picking which warehouse fulfills an order when multiple exist is
  not implemented — out of scope until a client actually operates more than
  one warehouse.
