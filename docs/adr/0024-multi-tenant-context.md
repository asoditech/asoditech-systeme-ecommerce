# ADR 0024 — Multi-tenant context & isolation (Phase 2)

## Status
Accepted (2026-09-06)

## Context
Phase 1 (ADR 0023) added a `tenantId` column, a backfilled bootstrap tenant
(`id = "default"`), and a column default — but nothing at runtime reads or
enforces it. Phase 2 makes tenant isolation real at the application layer:
every tenant-owned query is scoped to the acting tenant, and cross-tenant
reads and writes become impossible on the paths that go through the Prisma
client. UI, provisioning, invitations, tenant switching, RLS, billing and
custom roles are explicitly out of scope.

## Decision

### 1. Two clients — `prismaBase` and `prisma`
`src/lib/prisma.ts` now exports:
- `prismaBase` — the raw `PrismaClient`. Used only where scoping must not
  apply and would recurse: session resolution (`src/lib/auth/session.ts`),
  the seed script, and `resetDb`.
- `prisma` — `prismaBase.$extends(tenantExtension)`. The default everywhere
  else, including inside `prisma.$transaction(async (tx) => …)` — a query
  extension applies to the interactive-transaction client too (verified),
  so all 24 transaction sites are covered with no change.

`PrismaTransactionClient` (exported) is the `tx` type for helpers that take
one — it is **not** `Prisma.TransactionClient`, because `prisma` is
`$extends`-wrapped.

### 2. Request-scoped tenant context — `src/lib/tenant/context.ts`
An `AsyncLocalStorage<TenantDirective>` where a directive is
`{ mode: "scoped"; tenantId; source }` or `{ mode: "unscoped"; reason }`.
- `runWithTenant(tenantId, source, fn)` — pins scoping to one tenant.
- `runUnscoped(reason, fn)` — disables scoping for an audited reason.

Both are `async` and `await` `fn` **inside** the `storage.run` callback, so
a lazy `PrismaPromise` returned by `fn` still executes with the directive
active (the query fires only when awaited).

### 3. Resolution order — `src/lib/tenant/resolve.ts`
`resolveActiveTenant(model, operation)` returns, in strict precedence:
1. an explicit **directive** (`scoped` → its id; `unscoped` → no filter);
2. the **ambient session** tenant — `getCurrentUser().tenantId`, wrapped in
   React `cache()` so a request does at most one session lookup even though
   the extension runs per query;
3. the **bootstrap fallback** — `"default"`, logged once per model via
   `console.warn`. This is the single temporary fallback (see below).

### 4. The extension — `src/lib/tenant/extension.ts`
`Prisma.defineExtension({ query: { $allModels: { $allOperations } } })`,
active only for the 35 models that carry a `tenantId` (derived from
`Prisma.dmmf`):
- reads / `findUnique*` / `count` / `aggregate` / `groupBy` / `updateMany` /
  `delete` / `deleteMany` → merge `{ tenantId }` into `where`;
- `create` / `createMany` / `upsert.create` → force `data.tenantId`;
- any `where`, `data`, `create` or `update` that carries an explicit,
  **different** `tenantId` → throw `TenantIsolationError` (this is what
  removes "silently read/write another tenant's rows").
- `unscoped` directive → pass through untouched.

### 5. Entry points wired
- `src/lib/auth/session.ts` — uses `prismaBase`; `CurrentUser` gains
  `tenantId`.
- `src/actions/auth.ts` — login looks up the user by globally-unique email
  in `runUnscoped`, then runs session creation + audit in
  `runWithTenant(user.tenantId, …)`.
- `src/app/api/webhooks/{woocommerce,shopify}/route.ts` — resolve the
  `Integration` row with `prismaBase`, then run the whole handler in
  `runWithTenant(integration.tenantId, "webhook:*")`. The tenant is never
  taken from the request body.
- `prisma/seed.ts` — unchanged (already a raw client; DB default applies).
- `tests/helpers/db.ts`, `tests/helpers/auth.ts` — use `prismaBase` so
  fixtures and cleanup span every tenant.

## Known bypasses / temporary fallbacks (all documented in-code)
| Path | Why it bypasses | Mitigation now | Closed by |
| --- | --- | --- | --- |
| No directive **and** no session | background jobs, seed, most unit tests | `"default"` + `warnOnce` per model | Phase 3 tightens to throw once provisioning exists |
| `src/lib/queries/inventory.ts` raw `$queryRaw` counts | raw SQL can't go through the extension | `assertBootstrapTenant()` — throws for any non-default tenant | Phase 3: add `ii."tenantId"` predicate |
| `pg_advisory_xact_lock`, `SELECT … FOR UPDATE` by id, `ensureInventoryItem` raw INSERT | lock-only / id-scoped inside an already-scoped transaction | inline comment; id comes from a prior scoped read; INSERT lands in the DB column default | Phase 4 (RLS) |
| Nested writes (`order.create({ data: { items: { create } } })`) and nested `include` reads | Prisma client-extension limitation | rows fall to the Phase 1 column default; parent is already tenant-scoped | Phase 4 (RLS) |
| `findUnique` by a globally-unique non-id (`email`, `provider`, `slug`, `sku`, `name`) | still globally unique in the schema | extension merges `tenantId` (runtime-verified); login/webhooks use unscoped | Phase 3 (composite uniques) |

## Consequences
- Cross-tenant read/update/delete/create through `prisma` is now blocked and
  tested adversarially (`tests/lib/tenant-isolation.test.ts`).
- `AsyncLocalStorage` isolates the directive per async call tree —
  concurrent requests for different tenants cannot leak
  (`tests/lib/tenant-context-concurrency.test.ts`).
- In tests the ambient resolver is not memoised (React `cache()` no-ops
  outside a request), so `loginAsTestUser` + bare `prisma` calls do one
  extra session lookup per query — a measured test-time cost, not a
  correctness issue.
- The bootstrap fallback keeps every not-yet-wired path working while a
  single tenant exists; each is visible in logs.
