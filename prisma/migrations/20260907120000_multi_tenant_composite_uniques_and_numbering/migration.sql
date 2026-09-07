-- Phase 3 — composite tenant-scoped uniques + per-tenant numbering.
-- See docs/adr/0025-multi-tenant-isolation.md.
--
-- Three independent changes, each safe with the single bootstrap tenant
-- Phase 1 backfilled everything into (global uniqueness is a superset of
-- per-tenant uniqueness with exactly one tenant, so none of the new
-- composite unique indexes below can fail against current data):
--
-- 1. Per-tenant DISPLAY numbering for orders/transfers/stocktakes —
--    `tenants.nextOrderNumber` (+ transfer/stocktake siblings), and a
--    nullable `displayNumber` column on each of the three tables. The
--    counters are backfilled to MAX(existing global number for that
--    tenant) + 1, so the bootstrap tenant's next DISPLAY number continues
--    seamlessly from wherever its global sequence already was — no visible
--    jump. `displayNumber` itself is left NULL on every existing row
--    (never backfilled/renumbered): the app falls back to the historical
--    global orderNumber/transferNumber/sessionNumber for those.
--
-- 2. `business_settings.id` moves off its DB-level literal DEFAULT
--    'singleton' — Phase 3 makes this table tenant-scoped (one row per
--    tenant, looked up by tenantId, not a global singleton), and a new
--    row's id is now a normal cuid() generated client-side. The existing
--    bootstrap row keeps id = 'singleton' (never rewritten).
--
-- 3. Seven global unique constraints (Phase 1's ADR 0023 deliberately left
--    these untouched) become composite `(tenantId, ...)` uniques: users.email,
--    products.sku, product_variations.sku, categories.slug,
--    expense_categories.name, integrations.provider, and
--    orders(source, externalId). Plus two brand-new composite uniques for
--    the DISPLAY numbers themselves (orders/stock_transfers/stocktake_sessions,
--    all NULL-safe under Postgres' multiple-NULLs-allowed semantics).

-- ---------------------------------------------------------------------------
-- Step 1 — per-tenant numbering: counters on tenants, nullable display
-- columns on the three numbered tables.
-- ---------------------------------------------------------------------------
ALTER TABLE "tenants" ADD COLUMN "nextOrderNumber" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "tenants" ADD COLUMN "nextTransferNumber" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "tenants" ADD COLUMN "nextStocktakeNumber" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "orders" ADD COLUMN "displayNumber" INTEGER;
ALTER TABLE "stock_transfers" ADD COLUMN "displayNumber" INTEGER;
ALTER TABLE "stocktake_sessions" ADD COLUMN "displayNumber" INTEGER;

-- Seed each tenant's counter to continue right where its own existing
-- global-sequence high-water mark left off (0 + 1 = 1 for a tenant with no
-- rows yet, e.g. one created after this migration).
UPDATE "tenants" t
SET "nextOrderNumber" = COALESCE((SELECT MAX(o."orderNumber") FROM "orders" o WHERE o."tenantId" = t.id), 0) + 1;

UPDATE "tenants" t
SET "nextTransferNumber" = COALESCE((SELECT MAX(s."transferNumber") FROM "stock_transfers" s WHERE s."tenantId" = t.id), 0) + 1;

UPDATE "tenants" t
SET "nextStocktakeNumber" = COALESCE((SELECT MAX(s."sessionNumber") FROM "stocktake_sessions" s WHERE s."tenantId" = t.id), 0) + 1;

-- ---------------------------------------------------------------------------
-- Step 2 — business_settings becomes tenant-scoped, not a global singleton.
-- ---------------------------------------------------------------------------
ALTER TABLE "business_settings" ALTER COLUMN "id" DROP DEFAULT;

DROP INDEX "business_settings_tenantId_idx";
CREATE UNIQUE INDEX "business_settings_tenantId_key" ON "business_settings"("tenantId");

-- ---------------------------------------------------------------------------
-- Step 3 — global uniques -> composite (tenantId, ...) uniques.
-- ---------------------------------------------------------------------------
DROP INDEX "users_email_key";
CREATE UNIQUE INDEX "users_tenantId_email_key" ON "users"("tenantId", "email");

DROP INDEX "products_sku_key";
CREATE UNIQUE INDEX "products_tenantId_sku_key" ON "products"("tenantId", "sku");

DROP INDEX "product_variations_sku_key";
CREATE UNIQUE INDEX "product_variations_tenantId_sku_key" ON "product_variations"("tenantId", "sku");

DROP INDEX "categories_slug_key";
CREATE UNIQUE INDEX "categories_tenantId_slug_key" ON "categories"("tenantId", "slug");

DROP INDEX "expense_categories_name_key";
CREATE UNIQUE INDEX "expense_categories_tenantId_name_key" ON "expense_categories"("tenantId", "name");

DROP INDEX "integrations_provider_key";
CREATE UNIQUE INDEX "integrations_tenantId_provider_key" ON "integrations"("tenantId", "provider");

DROP INDEX "orders_source_externalId_key";
CREATE UNIQUE INDEX "orders_tenantId_source_externalId_key" ON "orders"("tenantId", "source", "externalId");

-- New — the per-tenant DISPLAY number itself. Postgres allows multiple
-- NULLs in a unique index, so this never restricts an existing (NULL
-- displayNumber) row.
CREATE UNIQUE INDEX "orders_tenantId_displayNumber_key" ON "orders"("tenantId", "displayNumber");
CREATE UNIQUE INDEX "stock_transfers_tenantId_displayNumber_key" ON "stock_transfers"("tenantId", "displayNumber");
CREATE UNIQUE INDEX "stocktake_sessions_tenantId_displayNumber_key" ON "stocktake_sessions"("tenantId", "displayNumber");
