# ADR 0025 — Multi-tenant isolation: composite uniques, tenant-scoped
# settings, per-tenant numbering (Phase 3)

## Status
Accepted (2026-09-07)

## Context
Phase 1 (ADR 0023) added the `tenantId` column and a bootstrap tenant.
Phase 2 (ADR 0024) made the Prisma client extension enforce tenant
isolation at the application layer, and documented five known bypasses —
global unique constraints, the `BusinessSettings` singleton, the global
order/transfer/stocktake numbering, the bootstrap-tenant fallback (which
also applied to *creates*), and a couple of raw-SQL paths. All were
explicitly deferred: safe only while a single tenant exists.

Phase 3 closes every one of those that is fixable at the application/query
level, leaving only genuine Postgres RLS territory (locking/inserting by
an id that already came from a prior tenant-scoped read) for Phase 4.

## Decision

### 1. Composite tenant-scoped unique constraints
Seven models had a Phase-1-preserved *global* unique constraint. Each
becomes `@@unique([tenantId, ...])`:

| Model | Was | Now |
| --- | --- | --- |
| `User` | `email` | `(tenantId, email)` |
| `Product` | `sku` | `(tenantId, sku)` |
| `ProductVariation` | `sku` | `(tenantId, sku)` |
| `Category` | `slug` | `(tenantId, slug)` |
| `ExpenseCategory` | `name` | `(tenantId, name)` |
| `Integration` | `provider` | `(tenantId, provider)` |
| `Order` | `(source, externalId)` | `(tenantId, source, externalId)` |

Every `findUnique`/`upsert` that used one of these fields alone is fixed:
- A pre-create duplicate check (`findUnique({ where: { sku } })`) becomes
  `findFirst` — the extension still scopes it to the active tenant, so
  behaviour for a single tenant is identical, and it now correctly ignores
  another tenant's row with the same value.
- `Integration`'s `connectIntegrationAction` upsert now keys on the real
  compound selector `tenantId_provider` (the active tenant is already
  known — the caller has a session).
- **Login** (`src/actions/auth.ts`) can no longer find "the" user by email
  alone (email is unique per tenant, not globally). It fetches every
  candidate across every tenant (`runUnscoped`, since the tenant isn't
  known yet) and disambiguates by password: the first `ACTIVE` candidate
  whose password verifies identifies both the user and their tenant. A
  failure audit event is attributed to a specific account only when the
  email resolved to exactly one candidate; with several, "which one" is
  ambiguous by design and it's logged as `"unknown"`.
- **Webhooks** (`src/app/api/webhooks/{woocommerce,shopify}/route.ts`) can
  no longer resolve their `Integration` row by `provider` alone. Both
  routes now read the raw body once, then try every candidate
  `Integration` row for that provider (`prismaBase`, unscoped — there is
  no tenant yet) against the signature, and use whichever one verifies —
  the same technique a multi-account webhook consumer (e.g. Stripe
  Connect) uses. A signature matching no candidate is a 401 with the
  audit event attributed to `"unknown"` (never a specific integration —
  which one it was "for" is genuinely unknowable). This also removed the
  old *second* decrypt/verify pass inside the handler; resolution already
  did it once.

### 2. `BusinessSettings` is tenant-scoped, not a global singleton
`id` moves off its DB-level literal default `'singleton'` to a normal
`cuid()`; `tenantId` gets `@unique` (replacing the old plain index — "one
settings row per tenant" is now DB-enforced, not just convention). Every
lookup/write (`src/actions/settings.ts`,
`src/app/(protected)/parametres/page.tsx`) keys on `tenantId`, never `id`.
The bootstrap tenant's existing row keeps its literal id `'singleton'`
(never rewritten by the migration).

### 3. Per-tenant DISPLAY numbering (orders, transfers, stocktakes)
`Order.orderNumber` / `StockTransfer.transferNumber` /
`StocktakeSession.sessionNumber` are **untouched** — still a single
global `@unique @default(autoincrement())` sequence shared across every
tenant, forever, as the immutable internal identity. Nothing about them
changes: no renumbering, no reuse, same uniqueness guarantee.

What a user actually sees ("CMD-000123") is a *new*, separate, per-tenant
counter:
- `Tenant.nextOrderNumber` / `nextTransferNumber` / `nextStocktakeNumber`
  (`Int @default(1)`) — "the next value to hand out for this tenant".
- A nullable `displayNumber` column on `Order` / `StockTransfer` /
  `StocktakeSession`, with `@@unique([tenantId, displayNumber])`
  (Postgres allows multiple NULLs, so every pre-Phase-3 row is
  unrestricted).
- `src/lib/tenant/numbering.ts`'s `claimTenantDisplayNumber(client,
  tenantId, kind)` claims the next value atomically via a single
  row-locked `UPDATE tenants SET x = x + 1 … RETURNING x` — safe under
  concurrent creates for the same tenant, no separate advisory lock
  needed, and works whether `client` is `prisma` or an open `tx` (`Tenant`
  itself is never tenant-scoped, so it passes through the isolation
  extension untouched).
- Called once per creation, in the same transaction where practical
  (`src/actions/orders.ts`, `src/actions/transfers.ts`,
  `src/actions/stocktakes.ts`) or immediately after (the WooCommerce/
  Shopify order-import pipelines, which aren't already transactional).
- `src/lib/format.ts`'s `resolvedDisplayNumber()` /
  `displayOrderNumber()` / `displayTransferNumber()` /
  `displayStocktakeNumber()` prefer `displayNumber`, falling back to the
  legacy global number when it's null — so a pre-Phase-3 row's displayed
  reference never changes.
- The migration backfills every tenant's counters to
  `MAX(existing global number for that tenant) + 1`, so the bootstrap
  tenant's next DISPLAY number continues seamlessly from wherever its
  global sequence already was — no visible jump for the only tenant that
  exists today. A brand-new tenant created later starts at 1.

### 4. Missing tenant context now rejects a CREATE, instead of a silent
   bootstrap-tenant fallback
Phase 2's fallback (no directive, no session → tenant `"default"`,
warned once per model) applied uniformly to every operation, including
creates — meaning a genuinely context-less create silently became a new
row in the bootstrap tenant. `resolveActiveTenantForCreate()` in
`src/lib/tenant/resolve.ts` keeps that resolution order for reads/
updates/deletes, but for the create family (`create`/`createMany`/
`createManyAndReturn`/`upsert`) throws `TenantContextRequiredError`
instead of falling back — **outside the test environment**. Every real
runtime create path already has a session (Server Actions/Components) or
an explicit `runWithTenant`/`runUnscoped` directive (the two webhook
routes, login); a create genuinely reaching the fallback in production is
a bug, not a legitimate case. Tests are carved out because the *existing*
suite deliberately exercises bare `prisma.x.create()` fixtures with no
session/directive — ADR 0024 already named this "most unit tests" as a
legitimate fallback consumer, and rewriting hundreds of fixtures is out of
scope for what this closes. `tests/lib/tenant-phase3.test.ts` proves the
throw path itself by stubbing `NODE_ENV`.

### 5. Raw-SQL bypasses
- `src/lib/queries/inventory.ts`'s two raw `$queryRaw` cross-joins (low
  stock / out-of-stock listing) now carry a real `ii."tenantId" = $1`
  predicate (`resolveActiveTenantIdForRawSql()`), replacing the old
  bootstrap-only guard (`assertBootstrapTenant`, now deleted — it has no
  remaining callers).
- `src/lib/inventory.ts`'s `ensureInventoryItem` raw `INSERT … ON
  CONFLICT DO NOTHING` now stamps `tenantId` itself — previously it fell
  to the column default (`"default"`) regardless of the active tenant,
  which was silently wrong (though self-detecting: the immediately
  following tenant-scoped `findUniqueOrThrow` would throw "not found" for
  any other tenant).
- What's left — `pg_advisory_xact_lock`, `SELECT … FOR UPDATE` by id, and
  the id lookups inside those two raw paths — is genuinely Phase 4 (RLS)
  territory: every one locks/inserts by an id that already came from a
  prior tenant-scoped read in the same transaction, so it's safe today by
  construction, not by a guard.

## What this explicitly does NOT do
No Postgres RLS (Phase 4 — `SET LOCAL app.current_tenant`, the PgBouncer
transaction-pool caveat). No provisioning UI, invitations, password reset,
`/platform` vendor area, custom roles, or billing (Phase 5+). No change to
nested-write/nested-`include` isolation (still the Phase 1 column default,
same as ADR 0024 documented — closed by RLS).

## Consequences
- Two tenants can each have a user/product/category/expense-category/
  integration/order-identity that collides on the old global-unique
  field, fully isolated (`tests/lib/tenant-phase3.test.ts`, adversarial).
- Settings, and the display numbers shown for orders/transfers/
  stocktakes, are genuinely per-tenant — verified with two tenants side
  by side, and verified NOT to renumber a single pre-existing row.
- Login and both webhook routes correctly resolve which tenant an
  ambiguous, session-less request belongs to
  (`tests/actions/auth.test.ts`, `tests/webhooks/*.test.ts`).
- `resetDb()` (test helper) now also resets the bootstrap tenant's
  numbering counters — the `Tenant` row itself survives a reset (only
  child rows are wiped), so without this its counters would climb across
  the whole test suite instead of each test starting fresh.
- Existing single-tenant behaviour is unchanged: all 841 pre-Phase-3
  tests pass unmodified, and the migration backfill was verified against
  a production-shaped clone (see the migration's own commit).
