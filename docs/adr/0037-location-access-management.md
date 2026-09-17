# ADR 0037 — Location Access Management v1

## Status
Accepted (2026-09-17)

## Context
Phases 32a–32c (ADR 0019/0020/0021) and ADR 0036 built a fully multi-location
inventory engine — warehouse-scoped `InventoryItem`, stock transfers,
stocktaking, and a single-source-of-truth fulfillment lifecycle — but never
added an authorization layer on top of it. Any authenticated user holding a
role-level permission (`inventory.adjust`, `inventory.transfer`,
`inventory.count`, `orders.create`, `orders.return`) could operate on
**every** warehouse in the tenant. A prior read-only audit (see the Location
Management v1 architecture report) confirmed `Warehouse` already carries
everything a physical-location entity needs (`type`, `isActive`, `tenantId`,
`address`) and recommended closing the gap with a `User ↔ Warehouse`
authorization bridge — not a new location model.

## Decision

### 1. `UserLocation` — the only new model
A join table: `id`, `tenantId`, `userId`, `warehouseId`, `createdAt`,
`createdById`. `@@unique([userId, warehouseId])`, tenant-scoped like every
other model (`@@index([tenantId])`), `onDelete: Cascade` on `userId`
(mirrors `Session`/`PasswordResetToken` — an assignment is meaningless once
the user is gone), `onDelete: Restrict` on `warehouseId` (mirrors every
other FK to `Warehouse` — a location is deactivated, never deleted, so this
never actually blocks anything). RLS: identical `tenant_isolation` policy
shape as every other tenant-scoped table (ADR 0026) — no new mechanism.

`Warehouse` itself gets **zero** schema changes.

### 2. OWNER/ADMIN bypass; everyone else is defined entirely by their rows
`hasGlobalLocationAccess(role)` (`src/lib/auth/location-access.ts`) —
`role === "OWNER" || role === "ADMIN"`. These two roles need no
`UserLocation` row at all; every other role's access is **exactly** their
assigned set. Zero rows means zero warehouses — never interpreted as "all"
(safe default-deny, the same philosophy as RLS's own `NULL` GUC default).

### 3. `requireLocationAccessForAction(user, warehouseId)` — the guard
The Server-Action-side authorization boundary, named to match
`requirePermissionForAction`. Called **after** the caller has already
resolved the target `Warehouse` row (existence + `isActive`, exactly as
every warehouse-touching action already did) — a forged id for another
tenant is already unreachable at that point (the tenant-scoped `prisma`
client's `findUnique` returns `null` for it), so this function's only job
is the intra-tenant question: is this warehouse in this user's assigned
set. One indexed existence check (`userId_warehouseId` compound unique),
no list ever loaded for a single check.

### 4. `listAccessibleActiveWarehouses(user)` / `resolveAuthorizedDefaultWarehouseId(user)`
The read-side helpers. The first replaces the pre-v1
`listSelectableFulfilmentWarehouses` (now deleted) for every warehouse
picker (order form, transfer form, stocktake form, stock report) — OWNER/
ADMIN get every active warehouse (identical to pre-v1 behavior), everyone
else gets only their assigned, active ones. The second resolves
`createOrderAction`'s no-explicit-choice default: OWNER/ADMIN keep the
**exact** pre-existing behavior (the tenant's single default warehouse,
`null` included for the pre-existing "no default warehouse configured"
edge case); every other role resolves within their own authorized set —
their assigned default if it's in that set, else their sole authorized
warehouse, else `null` (rejected by `createOrderAction` rather than
silently assigning something unauthorized).

### 5. What's actually gated
- `adjustInventoryAction` — the target warehouse.
- `createStockTransferAction` / `updateStockTransferDraftAction` /
  `cancelStockTransferAction` — **both** source and destination (moving
  stock between two locations requires seeing both).
- `dispatchStockTransferAction` — the source only (stock leaves it).
- `receiveStockTransferAction` — the destination only (stock arrives there).
- `listSourceStockAction` — the warehouse whose stock it exposes.
- `createStocktakeSessionAction` / `updateStocktakeCountsAction` /
  `finalizeStocktakeSessionAction` / `cancelStocktakeSessionAction` — the
  session's own single warehouse.
- `createOrderAction` — an explicit `fulfillmentWarehouseId` override, and
  the no-override default-resolution path (§4).
- `confirmPhysicalReturnAction` — the order's own recorded fulfillment
  warehouse (or, for a null-`fulfillmentWarehouseId` legacy order, the same
  warehouse `resolveOrderStockWarehouseId` would resolve for its first
  line) — never a new, user-chosen warehouse.
- The stock report (`/rapports/stock` page and its CSV export route) — an
  explicit `?warehouseId=` selection is validated against the caller's own
  authorized set; an unfiltered report for a scoped user is restricted to
  that set server-side, not just in the picker.

### 6. What's deliberately NOT gated
- Warehouse CRUD (`warehouses.manage`) — unchanged, an org-structure
  decision, not an operational one (ADR 0019 §7).
- Order/transfer/stocktake **visibility** (list/detail pages) — stays
  role-based, matching the existing philosophy that hiding a nav link or a
  row is convenience, not the security boundary; only the *mutations* and
  the *warehouse-selection pickers* are location-scoped in v1.
- `updateOrderStatusAction` / `cancelOrderAction` / `reopenOrderAction` —
  a status transition (including EXPEDIEE) never re-validates location
  access; the fulfillment warehouse was already authorized once, at
  creation, and is immutable afterward (ADR 0020) — this ADR does not
  reopen that immutability.
- Any report other than the stock report — global/role-scoped as before.
- External-store-to-location mapping — out of scope; `Integration` still
  allows exactly one WooCommerce and one Shopify connection per tenant, and
  WooCommerce still has no location concept.

### 7. User-management UI
`src/actions/users.ts`'s `setUserLocationsAction` — `users.manage`-gated
(today, only OWNER/ADMIN hold it), replaces a user's *entire* assignment
set in one transactional diff (remove what's no longer selected, add what's
new), audited as `user.locations_updated`. Assigning OWNER/ADMIN is a
documented no-op with a friendly rejection (they're already global). A
`UserLocationsDialog` on `/utilisateurs` lets an admin check/uncheck active
warehouses per user; OWNER/ADMIN rows show "Tous les emplacements" instead
of the picker.

### 8. Migration & backfill
`prisma/migrations/20260917113025_user_location_access/`. Creates the
table + RLS policy, then backfills: every existing **non-OWNER/non-ADMIN**
user gets an explicit `UserLocation` row for every warehouse that already
exists **in their own tenant** at migration time — preserving current
production behavior exactly (nobody who could already touch a warehouse
yesterday is locked out today). This is a one-time snapshot of the
migration's own moment, not a standing rule: a warehouse created afterward
does not retroactively grant itself to anyone, and a user created
afterward starts with zero assignments — explicit assignment is the
standing policy from here on, matching the existing `createWarehouseAction`
(no auto-grant to any user) and `inviteUserAction` (no auto-grant) code.

## Rejected alternatives
- **A new `Location` model.** Rejected — `Warehouse` already carries every
  field a physical location needs; forking it would fragment
  `InventoryItem`/`InventoryMovement`/`StockTransfer`/`StocktakeSession`/
  `Order.fulfillmentWarehouseId`, all of which already anchor to
  `Warehouse`, for no functional gain.
- **A global "active location" context** (a session-wide selected
  warehouse, a sidebar switcher). Rejected — nothing in the existing UX has
  this concept (no POS exists), every location-touching screen already has
  its own explicit picker, and adding one would be new architectural
  surface without a workflow that needs it.
- **Location-based order visibility.** Rejected for v1 — a materially
  bigger change (order list/detail queries, not just a picker) with no
  clear business requirement yet; explicitly deferred, not built partially.
- **Reject-vs-fallback for `createOrderAction`'s no-override path.** For a
  scoped user with zero authorized warehouses, resolving to *any* warehouse
  (even the tenant default) would violate "never silently assign an
  unauthorized warehouse" — rejecting with a clear error was the only
  option consistent with the zero-assignment policy (§2).

## Consequences
- Fully additive: the full pre-existing regression suite (1422 tests)
  passes unmodified in intent — pre-existing tests that exercised
  warehouse-scoped actions as a non-admin role were updated to grant that
  role the same access an admin would have already given it (test-fixture
  maintenance, not a behavior change).
- `Warehouse` referenced by a `UserLocation` row can no longer be deleted
  (`onDelete: Restrict`) — moot in practice, since no delete action exists
  for `Warehouse` at all (ADR 0019).
- A tenant with a single warehouse (the common case) sees zero practical
  change: every non-admin user is backfilled with access to it, and the
  order form still shows no picker (one authorized choice, same as one
  total choice pre-v1).

## Not built in v1
Shopify fulfillment-location mapping (`Order.fulfillmentWarehouseId` from
the originating Shopify Location — a separate, pre-existing gap, not
mixed into this feature), multi-store-per-provider, POS, location-based
order visibility, a global location selector, location filtering on any
report besides stock valuation.
