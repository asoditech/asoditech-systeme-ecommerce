# ADR 0023 — Multi-tenant foundation (Phase 1)

## Status
Accepted (2026-09-06)

## Context
ADR 0002 chose **deployment-level** multi-tenancy: one database, one Vercel
project, one domain per client, with no `tenantId` anywhere in the schema.
We now want the option of **row-level** tenancy — several isolated client
workspaces sharing one deployment — without abandoning the per-deployment
model for clients who need it.

A read-only audit (see the multi-tenant readiness report) mapped the full
gap: 36 models with zero tenant columns, auth/session/RBAC with no tenant
concept, ~410 `prisma.*` call sites with no scoping, and a handful of global
unique constraints (`users.email`, `products.sku`, `integrations.provider`,
the `business_settings` singleton, the `orders.orderNumber` sequence …) that
a real multi-tenant system will eventually have to scope.

That is a large surface. This ADR covers **only Phase 1 — the safest
foundation**: the `tenantId` column and its backfill, and nothing else.

## Decision

### 1. `Tenant` model + one bootstrap tenant
- New `Tenant` (`id`, `name`, `slug @unique`, `status` = `ACTIVE` /
  `SUSPENDED`, timestamps). `@@map("tenants")`.
- `Tenant.id` defaults to the literal `"default"` — the same well-known
  singleton pattern as `BusinessSettings.id = "singleton"` and
  `Warehouse.id = "default-warehouse"`. The migration and the seed both
  create exactly one row, `id = "default"`, `slug = "default"`.

### 2. `tenantId` on User + the 34 business/data models
- Every scoped model gains `tenantId String @default("default")`, a
  `tenant Tenant @relation(..., onDelete: Restrict)` FK, and
  `@@index([tenantId])`.
- **`Session` is deliberately excluded** — it is scoped through its `User`,
  and a session row never needs an independent tenant.
- The `@default("default")` is the crux of "no runtime behaviour change":
  Prisma supplies it on every `.create()`, so **no application code and no
  test had to change**. It is a transitional scaffold — a later phase drops
  the default once real tenant context is wired.

### 3. Unique constraints are left untouched
Global uniques (`users.email`, `products.sku`, `product_variations.sku`,
`categories.slug`, `expense_categories.name`, `integrations.provider`,
`orders (source, externalId)`, the autoincrement sequences, …) are **not**
changed in Phase 1. With exactly one tenant, global uniqueness is a strict
superset of per-tenant uniqueness, so nothing breaks. Converting them to
composite `@@unique([tenantId, …])` and adding per-tenant numbering is
Phase 3 work and needs its own ADR.

### 4. Migration — `20260906130000_multi_tenant_foundation`
Hand-written in the house style (cf.
`20260903131628_stock_transfers_and_order_fulfilment`):
1. create `TenantStatus`, `tenants`, `tenants_slug_key`;
2. `INSERT` the `default` tenant (before any FK, so they validate);
3. add every `tenantId` **nullable**;
4. `UPDATE … SET 'default' WHERE tenantId IS NULL` per table;
5. one `DO` block that `RAISE EXCEPTION`s if any scoped table still has a
   NULL `tenantId`;
6. `SET NOT NULL` + `SET DEFAULT 'default'` per table;
7. `CREATE INDEX` + `ADD … FOREIGN KEY … ON DELETE RESTRICT` per table.

`prisma migrate diff --from-migrations --to-schema-datamodel --exit-code`
reports "No difference detected"; a fresh-DB `prisma migrate deploy` of all
19 migrations succeeds; the backfill was verified against a clone of real
data.

## What this explicitly does NOT do
No tenant resolution, no `AsyncLocalStorage` context, no middleware change,
no Prisma client extension / query scoping, no Postgres RLS, no tenant
switcher, no invitations, no billing, no RBAC change, no role renames, no
`/platform` area. Those are Phases 2–6.

## Consequences
- **Backward compatible.** One tenant, every column defaulted and
  backfilled, every existing query returns exactly what it did before.
- Production applies it via `prisma migrate deploy` on the next deploy; the
  backfill is metadata-cheap (constant default) and the `DO` block is a
  guard, not a table scan risk at current data volumes.
- `Tenant` has 35 back-relations — verbose but standard, and it makes the
  FK direction explicit.
- The `@default("default")` must be removed deliberately in a later phase,
  at the same time tenant context starts being injected, or new rows would
  silently land in the bootstrap tenant.
