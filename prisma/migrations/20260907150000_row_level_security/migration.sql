-- Phase 4 — Row-Level Security. See docs/adr/0026-multi-tenant-rls.md.
--
-- Enables Postgres RLS on every tenant-scoped table (the 35 models with a
-- `tenantId` column — everything except `Tenant` itself and `Session`,
-- which is scoped through its `User`) and adds ONE policy per table:
--
--   USING (current_setting('app.bypass_rls', true) = 'on'
--          OR "tenantId" = current_setting('app.tenant_id', true))
--   WITH CHECK (<same>)
--
-- `current_setting(name, true)` returns NULL for a GUC nobody ever set in
-- this session/transaction — NULL never equals anything, so a connection
-- that never ran `SET LOCAL app.tenant_id = ...` (or the bypass GUC) sees
-- ZERO rows and can insert/update NONE. Default-deny, not default-allow.
--
-- `FORCE ROW LEVEL SECURITY` in addition to `ENABLE`: by default Postgres
-- exempts a table's OWNER from its own RLS policies (only a non-owner,
-- non-superuser role is restricted). This app's migrations run as the
-- owner (needs DDL rights); its RUNTIME connection must NOT be the owner
-- and must NOT have the `BYPASSRLS` role attribute, or these policies are
-- inert for it. FORCE is defense-in-depth for a deployment that ends up
-- using the same role for both — see the ADR's "Required manual step"
-- section for the actual role split this needs in every environment
-- (local dev/test included — this repo's default local Postgres role is
-- a superuser, which ALWAYS bypasses RLS regardless of FORCE).
--
-- A superuser (or any role with BYPASSRLS) bypasses RLS unconditionally —
-- always true of `postgres`/typical local-dev roles, which is exactly why
-- this migration alone does not "turn on" enforcement; the runtime role
-- swap is a required companion step, done once per environment, outside
-- migration history (it needs a password, which does not belong in a
-- versioned migration file).
--
-- This is DEFENSE IN DEPTH under the Phase 2/3 app-level Prisma extension
-- (src/lib/tenant/extension.ts), not a replacement for it — the app keeps
-- doing its own `where`/`data` scoping and rejects an explicit foreign
-- tenantId with a friendly `TenantIsolationError` before a query ever
-- reaches Postgres. RLS is what makes a bypass of that app-level layer
-- (a bug in a future code path, raw SQL, a nested Prisma write the
-- extension can't reach) fail closed instead of leaking data.

-- users
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "users"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- customers
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "customers"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- customer_addresses
ALTER TABLE "customer_addresses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_addresses" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "customer_addresses"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- categories
ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "categories" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "categories"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- products
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "products"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- product_images
ALTER TABLE "product_images" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_images" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "product_images"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- product_variations
ALTER TABLE "product_variations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_variations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "product_variations"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- warehouses
ALTER TABLE "warehouses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "warehouses" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "warehouses"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- inventory_items
ALTER TABLE "inventory_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "inventory_items"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- inventory_movements
ALTER TABLE "inventory_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_movements" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "inventory_movements"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- stock_transfers
ALTER TABLE "stock_transfers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_transfers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "stock_transfers"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- stock_transfer_lines
ALTER TABLE "stock_transfer_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_transfer_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "stock_transfer_lines"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- stocktake_sessions
ALTER TABLE "stocktake_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stocktake_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "stocktake_sessions"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- stocktake_lines
ALTER TABLE "stocktake_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stocktake_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "stocktake_lines"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- orders
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "orders"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- order_items
ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "order_items"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- refunds
ALTER TABLE "refunds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refunds" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "refunds"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- commission_agents
ALTER TABLE "commission_agents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "commission_agents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "commission_agents"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- commission_entries
ALTER TABLE "commission_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "commission_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "commission_entries"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- commission_statements
ALTER TABLE "commission_statements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "commission_statements" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "commission_statements"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- shipping_providers
ALTER TABLE "shipping_providers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shipping_providers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shipping_providers"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- delivery_city_mappings
ALTER TABLE "delivery_city_mappings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "delivery_city_mappings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "delivery_city_mappings"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- shipments
ALTER TABLE "shipments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shipments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shipments"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- delivery_manifests
ALTER TABLE "delivery_manifests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "delivery_manifests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "delivery_manifests"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- shipment_webhook_events
ALTER TABLE "shipment_webhook_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shipment_webhook_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "shipment_webhook_events"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- expense_categories
ALTER TABLE "expense_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "expense_categories" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "expense_categories"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- expenses
ALTER TABLE "expenses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "expenses" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "expenses"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- marketing_channels
ALTER TABLE "marketing_channels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "marketing_channels" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "marketing_channels"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- marketing_campaigns
ALTER TABLE "marketing_campaigns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "marketing_campaigns" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "marketing_campaigns"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- integrations
ALTER TABLE "integrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integrations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "integrations"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- sync_runs
ALTER TABLE "sync_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "sync_runs"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- webhook_events
ALTER TABLE "webhook_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "webhook_events"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- notifications
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "notifications"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- business_settings
ALTER TABLE "business_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "business_settings"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- audit_events
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "audit_events"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

