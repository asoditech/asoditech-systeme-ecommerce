# ADR 0026 — Multi-tenant isolation: Postgres Row-Level Security (Phase 4)

## Status
Accepted (2026-09-07)

## Context
Phases 1-3 (ADR 0023-0025) built tenant isolation entirely at the
**application** layer: a `tenantId` column, a request-scoped context, a
Prisma Client Extension that scopes `where`/`data` on every model
operation, composite tenant-scoped uniques, tenant-scoped settings and
numbering. Every phase document named the same ceiling: none of it is
enforced by the database. A bug in a future code path, a raw SQL query, or
a Prisma nested write the extension structurally can't reach (`include`,
`data: { relation: { create: … } }`) can still cross tenants — and two
specific, real bypasses were already identified and deliberately deferred:

- **Nested writes.** `order.create({ data: { items: { create: [...] } } })`
  — the extension only sees the top-level `Order.create` call; the nested
  `OrderItem` rows are created through Prisma's own internal nested-write
  mechanism, invisible to `$allOperations`. Before this phase, those rows
  silently fell to the `tenantId` column's `@default("default")` —
  correct only by coincidence, while a single tenant existed.
- **Nested reads.** `order.findUnique({ include: { items: true } })` — same
  blind spot in the other direction: the nested `OrderItem` SELECT never
  passed through the extension's `where` scoping.
- The **PgBouncer transaction-pooling caveat** ADR 0024 flagged from the
  start: this app's `DATABASE_URL` is the pooled connection, so any
  session-level mechanism (as opposed to transaction-scoped) risks leaking
  across requests that happen to reuse the same backend connection.

## Decision

### 1. Row-Level Security on every tenant-scoped table
All 35 models carrying a `tenantId` column (everything except `Tenant`
itself and `Session`, scoped through its `User`) get `ENABLE ROW LEVEL
SECURITY` + `FORCE ROW LEVEL SECURITY` and one policy:

```sql
CREATE POLICY "tenant_isolation" ON "<table>"
  USING (current_setting('app.bypass_rls', true) = 'on'
         OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on'
              OR "tenantId" = current_setting('app.tenant_id', true));
```

`current_setting(name, true)` returns `NULL` for a GUC nobody ever set in
this session/transaction, and `NULL` never equals anything — a connection
that never ran one of the mechanisms below sees **zero rows** on every
tenant-scoped table and can insert/update **none**. Default-deny, not
default-allow. `FORCE` closes the one Postgres carve-out that would
otherwise make this inert: by default RLS does not apply to a table's
*owner*. This app's migrations run as the owner (they need DDL rights);
`FORCE` means even a deployment that ends up running its app under the
same role stays protected. (A **superuser**, or any role with the
`BYPASSRLS` attribute, still bypasses RLS unconditionally regardless of
`FORCE` — this is exactly why the runtime role swap below is required, not
optional; this repo's default local Postgres role is a superuser.)

Migration: `prisma/migrations/20260907150000_row_level_security/`. RLS
policies aren't representable in `schema.prisma` at all, so `prisma
migrate diff --to-schema-datamodel` reports "No difference" before and
after this migration — expected, and not a signal this migration is a
no-op; it was verified directly (`pg_policies`, and end-to-end against a
production-shaped two-tenant data clone — see Consequences).

### 2. Required manual step — a restricted runtime role, per environment
RLS protects nothing if the connecting role bypasses it. **Every
environment** (this repo's local dev/test databases included) needs a
Postgres role for the app's `DATABASE_URL` that is:
- not a superuser,
- does not have the `BYPASSRLS` attribute,
- ideally does not own the tables (migrations should run as a separate
  role that does, via `DIRECT_URL`).

This is deliberately **not** part of the versioned migration — it needs a
password, which does not belong in migration history, and role
provisioning is infrastructure the migration file has no way to express
portably across providers anyway (matches how `DATABASE_URL` itself is
never created by a migration). Locally, this phase created:

```sql
CREATE ROLE asoditech_app WITH LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT USAGE ON SCHEMA public TO asoditech_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO asoditech_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO asoditech_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mac IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO asoditech_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mac IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO asoditech_app;
```

`.env` and `.env.test`'s `DATABASE_URL` now point at `asoditech_app`;
`DIRECT_URL` stays the owner role (`mac`) for migrations. **Production
needs the equivalent** — a non-owner, non-superuser, non-`BYPASSRLS` role
for the app's pooled connection — before this migration means anything
there.

### 3. Setting the GUC — `SET LOCAL`, always inside a real transaction
`SET LOCAL` is scoped to the current transaction and reverts automatically
at `COMMIT`/`ROLLBACK` — required, not a style choice: this app's
`DATABASE_URL` is the pooled (PgBouncer) connection, and in
transaction-pooling mode a session-scoped `SET` would leak onto whichever
unrelated request/tenant reuses that backend connection next. For that to
matter, the GUC must be the very first statement of every Postgres
transaction the app opens — including a single top-level Prisma call,
itself an implicit one-statement transaction with no natural hook to run
something "before" it. `src/lib/tenant/rls.ts`:

- **`wrapOperationWithTenant`/`wrapOperationWithBypass`** — for a bare
  top-level call (`prisma.order.findMany()`), batches the `SET` with the
  forwarded query into one real transaction:
  `prismaRaw.$transaction([setConfig, query(args)])`. Verified directly
  against Postgres: a Client Extension's forwarded `query(args)` is a
  lazy, unexecuted `PrismaPromise` — exactly what the batch-array form of
  `$transaction` expects, not an already-dispatched `Promise`.
- **`attachRlsTransaction`** — replaces `$transaction` itself (plain
  property reassignment; Prisma Client Extensions cannot override core
  client methods) so `prisma.$transaction(async (tx) => {...})` sets the
  GUC **once**, before the caller's callback runs, on that interactive
  transaction's own connection. An `AsyncLocalStorage` marker
  (`isInsideRlsTransaction`) then tells every *nested* `tx.model.op()`
  call inside that callback to skip re-wrapping itself — the GUC already
  applies to the whole transaction, including any raw
  `tx.$queryRaw`/`tx.$executeRaw` issued within it (advisory locks,
  `FOR UPDATE`, `ensureInventoryItem`'s raw `INSERT`, …), with zero
  changes needed at any of those call sites.
- The batch-array form of `$transaction` (`$transaction([p1, p2])`) is
  **not** supported on `prisma`/`prismaBase` — RLS needs a callback so
  `SET LOCAL` can run first, and nothing in the app actually needed the
  array form (`tests/helpers/db.ts`'s `resetDb()` was rewritten to the
  callback form; verified the only other caller).
- The handful of raw-SQL call sites that build their own
  `$queryRaw`/`$executeRaw` **outside** any `$transaction` (raw queries
  bypass `$allOperations` entirely — they aren't model operations) get a
  new `runRawBatchWithTenant(tenantId, queries)` — `src/lib/queries/
  inventory.ts`'s two cross-join reads.

### 4. `prismaBase` — same connection pool, a different extension
`prismaBase` ("raw", no app-level filtering — session resolution, the two
webhook routes' cross-tenant `Integration` lookup, the seed script, test
fixtures spanning tenants) is built from the **same** underlying
`PrismaClient` (`src/lib/tenant/raw-client.ts`, extracted to avoid a
circular import) as `prisma`, extended with `bypassExtension`
(`src/lib/tenant/bypass-extension.ts`) instead of `tenantExtension` — it
sets `app.bypass_rls = 'on'` on every call and `$transaction`,
unconditionally. Before RLS, "no app-level filtering" meant "sees
everything" by construction; now it needs this to still be true — a
`prismaBase` call with no bypass GUC would otherwise see zero rows, same
as anyone else. `src/actions/auth.ts`'s login and both webhook routes'
`runUnscoped(...)` blocks get the identical treatment through
`tenantExtension` itself (its `source === "unscoped"` branch now calls
`wrapOperationWithBypass` instead of passing the query through
unwrapped) — no changes needed at either call site.

### 5. Nested-write tenant stamping (the write-side blind spot, fixed at
   the app level, backstopped by RLS)
`extension.ts`'s `stampNestedWrites` walks a model's DMMF relation fields
and, for any pointing at another tenant-scoped model, recursively stamps
`tenantId` into `create`/`createMany.data`/`connectOrCreate.create`
payloads (and rejects a smuggled foreign `tenantId` there too, mirroring
the top-level `rejectForeignTenant`). The four real call sites this fixes:
`Order.items` (three creation paths — the order form, the WooCommerce and
Shopify import pipelines) and `StockTransfer.lines`.

This is a genuine, previously-silent correctness bug this phase's own
adversarial tests caught closing: **without it, RLS's `WITH CHECK` turns
the bug into a hard `PostgresError` for any non-default tenant**, because
the nested row's `tenantId` would fall to the column default (`"default"`)
while the transaction's GUC is set to the real active tenant — an INSERT
whose own value doesn't match `current_setting('app.tenant_id')` is
exactly what `WITH CHECK` exists to reject. Fixing the root cause (rather
than special-casing four call sites) means any future nested create is
covered automatically.

Nested **reads** need no equivalent fix: an `include`'s extra SQL runs on
the SAME connection/transaction as the outer call (Prisma decomposes one
logical call into several statements over one connection), which the
wrapping in §3 already covers — the database itself now filters them,
where the Phase 2 extension structurally could not.

### 6. A second, unrelated bug RLS surfaced: audit events inside a
   transaction, on the wrong client
`recordAuditEvent()` (`src/lib/audit.ts`) always used the top-level
`prisma`, even when called from inside an already-open
`prisma.$transaction(async (tx) => { …; await recordAuditEvent(...); })`
(`src/lib/integrations/shared/stock-reconcile.ts`). That was **always** a
latent atomicity gap — the audit write was never part of the caller's
transaction, so it wouldn't roll back with it — RLS turned it into a hard
failure instead: the outer transaction's GUC only applies to that
transaction's own connection, and a call through the *top-level* `prisma`
opens a **separate** mini-transaction of its own with no ambient GUC to
inherit, so the write had no RLS-visible tenant at all. Fixed by giving
`recordAuditEvent` an optional `tx` parameter (defaulting to `prisma`) and
passing it at the one call site that needed it. Every other call site
(audited, and confirmed by the full adversarial + existing suite) already
runs after its enclosing transaction commits, where the top-level client
is correct.

## What this explicitly does NOT do
No provisioning UI, invitations, password reset, `/platform` vendor area,
custom roles, billing, or scale-out (Phase 5+, unchanged from prior ADRs).
No change to WHICH rows the app-level extension scopes — RLS is layered
**under** it, not instead of it; the app still rejects an explicit foreign
`tenantId` with a friendly `TenantIsolationError` before a query ever
reaches Postgres, and still throws `TenantContextRequiredError` for a
context-less create outside tests (ADR 0025). No production role
provisioning — see §2, a required manual step per environment.

## Consequences
- **Real DB-level enforcement, proven independent of the app layer.**
  `tests/lib/tenant-rls.test.ts` talks to Postgres through `prismaRaw` —
  no app-level `where`/`data` scoping, no `TenantIsolationError` — and
  proves: zero rows with no GUC set; a raw `SELECT` never crosses tenants;
  a raw `INSERT` smuggling a foreign `tenantId` is rejected by `WITH
  CHECK`; a raw `UPDATE`/`DELETE` by id affects zero rows for another
  tenant's row; `SELECT … FOR UPDATE` can't even see a foreign row to lock
  it; a `pg_advisory_xact_lock` followed by a tenant-scoped read of the
  row it guards still sees nothing for another tenant's row; the bypass
  GUC and `prismaBase` genuinely see every tenant.
- **The nested-write bug is closed and tested**
  (`tests/lib/tenant-rls.test.ts`): a nested `order.create({ data: {
  items: { create: [...] } } })` under tenant B now stamps `tenantId =
  "tenant-b"` on the `OrderItem` row, not the column default — verified
  both directly and by RLS itself (tenant A can't see the nested item;
  tenant B can).
- **Every existing single-tenant behaviour still works.** All 861
  pre-Phase-4 tests pass unmodified against the RLS-enabled, restricted-
  role database, plus 11 new adversarial RLS tests — 872 total.
- **Migration verified**: applies cleanly on a fresh database (all 21
  migrations) and against a production-shaped two-tenant data clone with
  zero data loss, confirmed by direct `pg_policies` inspection and by
  querying as the restricted runtime role before/after.
- **Performance tradeoff, accepted for this exercise**: every top-level
  Prisma call not already inside an explicit transaction now opens its own
  two-statement transaction (`SET LOCAL` + the query) instead of a single
  autocommit statement — more round trips per request. This is the
  standard, accepted cost of Prisma+RLS integration; not addressed further
  here.
- `getCurrentUser()`'s session lookup (`prismaBase`, runs on nearly every
  request) now also opens a bypass-GUC transaction per call — same
  tradeoff, called out explicitly since it's the highest-frequency path
  affected.
