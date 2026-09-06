-- Phase 1 — multi-tenant foundation. See docs/adr/0023-multi-tenant-foundation.md.
--
-- Adds the `Tenant` table and a `tenantId` column to User + the 34 business
-- data models, and moves every existing row under a single bootstrap tenant
-- (id = 'default'). This is deliberately ONLY the column + backfill: no tenant
-- resolution, query scoping, RLS, invitations or provisioning ship here.
-- `tenantId` carries a column DEFAULT of 'default' so nothing at runtime (app
-- code, tests) has to pass it yet — behaviour is unchanged.
--
-- Hand-edited after `prisma migrate diff` so existing production rows are
-- backfilled the house-style way (add nullable -> backfill -> verify zero
-- NULLs -> SET NOT NULL) rather than relying solely on the column default —
-- same precedent as prisma/migrations/20260903131628_stock_transfers_and_order_fulfilment.
-- The end state is identical to what `prisma migrate diff` expects, so the
-- migrations tree stays in sync with the schema.

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- The one bootstrap tenant that owns all pre-existing data. Created before
-- the backfill so the foreign keys below validate. `updatedAt` has no DB
-- default (Prisma manages it), so it is set explicitly here.
INSERT INTO "tenants" ("id", "name", "slug", "status", "createdAt", "updatedAt")
VALUES ('default', 'ASODITECH', 'default', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- ---------------------------------------------------------------------------
-- Step 1 — add "tenantId" nullable on every scoped table.
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "customers" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "customer_addresses" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "categories" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "products" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "product_images" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "product_variations" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "warehouses" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "inventory_items" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "inventory_movements" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "stock_transfers" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "stock_transfer_lines" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "stocktake_sessions" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "stocktake_lines" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "orders" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "order_items" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "refunds" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "commission_agents" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "commission_entries" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "commission_statements" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "shipping_providers" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "delivery_city_mappings" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "shipments" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "delivery_manifests" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "shipment_webhook_events" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "expense_categories" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "expenses" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "marketing_channels" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "marketing_campaigns" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "integrations" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "sync_runs" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "webhook_events" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "notifications" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "business_settings" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "audit_events" ADD COLUMN "tenantId" TEXT;

-- ---------------------------------------------------------------------------
-- Step 2 — backfill every existing row to the bootstrap tenant.
-- ---------------------------------------------------------------------------
UPDATE "users" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "customers" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "customer_addresses" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "categories" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "products" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "product_images" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "product_variations" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "warehouses" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "inventory_items" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "inventory_movements" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "stock_transfers" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "stock_transfer_lines" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "stocktake_sessions" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "stocktake_lines" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "orders" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "order_items" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "refunds" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "commission_agents" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "commission_entries" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "commission_statements" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "shipping_providers" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "delivery_city_mappings" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "shipments" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "delivery_manifests" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "shipment_webhook_events" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "expense_categories" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "expenses" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "marketing_channels" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "marketing_campaigns" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "integrations" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "sync_runs" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "webhook_events" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "notifications" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "business_settings" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;
UPDATE "audit_events" SET "tenantId" = 'default' WHERE "tenantId" IS NULL;

-- ---------------------------------------------------------------------------
-- Step 3 — fail loudly if any scoped table still has a NULL "tenantId"
-- before the NOT NULL constraints go on.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  tbl TEXT;
  remaining BIGINT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'users', 'customers', 'customer_addresses', 'categories', 'products',
    'product_images', 'product_variations', 'warehouses', 'inventory_items',
    'inventory_movements', 'stock_transfers', 'stock_transfer_lines',
    'stocktake_sessions', 'stocktake_lines', 'orders', 'order_items', 'refunds',
    'commission_agents', 'commission_entries', 'commission_statements',
    'shipping_providers', 'delivery_city_mappings', 'shipments',
    'delivery_manifests', 'shipment_webhook_events', 'expense_categories',
    'expenses', 'marketing_channels', 'marketing_campaigns', 'integrations',
    'sync_runs', 'webhook_events', 'notifications', 'business_settings',
    'audit_events'
  ]
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE "tenantId" IS NULL', tbl) INTO remaining;
    IF remaining > 0 THEN
      RAISE EXCEPTION 'tenantId backfill incomplete on %: % row(s) still NULL', tbl, remaining;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Step 4 — enforce NOT NULL and attach the 'default' column default.
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "customers" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "customer_addresses" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "categories" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "products" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "product_images" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "product_variations" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "warehouses" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "inventory_items" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "inventory_movements" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "stock_transfers" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "stock_transfer_lines" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "stocktake_sessions" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "stocktake_lines" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "orders" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "order_items" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "refunds" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "commission_agents" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "commission_entries" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "commission_statements" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "shipping_providers" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "delivery_city_mappings" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "shipments" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "delivery_manifests" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "shipment_webhook_events" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "expense_categories" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "expenses" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "marketing_channels" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "marketing_campaigns" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "integrations" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "sync_runs" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "webhook_events" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "notifications" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "business_settings" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';
ALTER TABLE "audit_events" ALTER COLUMN "tenantId" SET NOT NULL, ALTER COLUMN "tenantId" SET DEFAULT 'default';

-- ---------------------------------------------------------------------------
-- Step 5 — indexes on "tenantId".
-- ---------------------------------------------------------------------------
CREATE INDEX "users_tenantId_idx" ON "users"("tenantId");
CREATE INDEX "customers_tenantId_idx" ON "customers"("tenantId");
CREATE INDEX "customer_addresses_tenantId_idx" ON "customer_addresses"("tenantId");
CREATE INDEX "categories_tenantId_idx" ON "categories"("tenantId");
CREATE INDEX "products_tenantId_idx" ON "products"("tenantId");
CREATE INDEX "product_images_tenantId_idx" ON "product_images"("tenantId");
CREATE INDEX "product_variations_tenantId_idx" ON "product_variations"("tenantId");
CREATE INDEX "warehouses_tenantId_idx" ON "warehouses"("tenantId");
CREATE INDEX "inventory_items_tenantId_idx" ON "inventory_items"("tenantId");
CREATE INDEX "inventory_movements_tenantId_idx" ON "inventory_movements"("tenantId");
CREATE INDEX "stock_transfers_tenantId_idx" ON "stock_transfers"("tenantId");
CREATE INDEX "stock_transfer_lines_tenantId_idx" ON "stock_transfer_lines"("tenantId");
CREATE INDEX "stocktake_sessions_tenantId_idx" ON "stocktake_sessions"("tenantId");
CREATE INDEX "stocktake_lines_tenantId_idx" ON "stocktake_lines"("tenantId");
CREATE INDEX "orders_tenantId_idx" ON "orders"("tenantId");
CREATE INDEX "order_items_tenantId_idx" ON "order_items"("tenantId");
CREATE INDEX "refunds_tenantId_idx" ON "refunds"("tenantId");
CREATE INDEX "commission_agents_tenantId_idx" ON "commission_agents"("tenantId");
CREATE INDEX "commission_entries_tenantId_idx" ON "commission_entries"("tenantId");
CREATE INDEX "commission_statements_tenantId_idx" ON "commission_statements"("tenantId");
CREATE INDEX "shipping_providers_tenantId_idx" ON "shipping_providers"("tenantId");
CREATE INDEX "delivery_city_mappings_tenantId_idx" ON "delivery_city_mappings"("tenantId");
CREATE INDEX "shipments_tenantId_idx" ON "shipments"("tenantId");
CREATE INDEX "delivery_manifests_tenantId_idx" ON "delivery_manifests"("tenantId");
CREATE INDEX "shipment_webhook_events_tenantId_idx" ON "shipment_webhook_events"("tenantId");
CREATE INDEX "expense_categories_tenantId_idx" ON "expense_categories"("tenantId");
CREATE INDEX "expenses_tenantId_idx" ON "expenses"("tenantId");
CREATE INDEX "marketing_channels_tenantId_idx" ON "marketing_channels"("tenantId");
CREATE INDEX "marketing_campaigns_tenantId_idx" ON "marketing_campaigns"("tenantId");
CREATE INDEX "integrations_tenantId_idx" ON "integrations"("tenantId");
CREATE INDEX "sync_runs_tenantId_idx" ON "sync_runs"("tenantId");
CREATE INDEX "webhook_events_tenantId_idx" ON "webhook_events"("tenantId");
CREATE INDEX "notifications_tenantId_idx" ON "notifications"("tenantId");
CREATE INDEX "business_settings_tenantId_idx" ON "business_settings"("tenantId");
CREATE INDEX "audit_events_tenantId_idx" ON "audit_events"("tenantId");

-- ---------------------------------------------------------------------------
-- Step 6 — foreign keys to "tenants". ON DELETE RESTRICT: a tenant with any
-- data cannot be removed (there is no delete path in Phase 1 anyway).
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ADD CONSTRAINT "users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_variations" ADD CONSTRAINT "product_variations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stocktake_sessions" ADD CONSTRAINT "stocktake_sessions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commission_agents" ADD CONSTRAINT "commission_agents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commission_statements" ADD CONSTRAINT "commission_statements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipping_providers" ADD CONSTRAINT "shipping_providers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_city_mappings" ADD CONSTRAINT "delivery_city_mappings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_manifests" ADD CONSTRAINT "delivery_manifests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_webhook_events" ADD CONSTRAINT "shipment_webhook_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "marketing_channels" ADD CONSTRAINT "marketing_channels_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "business_settings" ADD CONSTRAINT "business_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
