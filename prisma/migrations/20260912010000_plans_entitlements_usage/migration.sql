-- Plans, Subscriptions & Usage — the platform commercial layer.
-- See docs/adr/0035-plans-entitlements-usage.md.
--
-- Hand-written (house style, cf. 20260912000000_support_center): this
-- migration creates one GLOBAL catalogue table (`plans` — no tenantId,
-- no RLS, exactly like `tenants` itself) and two tenant-scoped tables
-- (`tenant_subscriptions`, `usage_alert_states`) that get the identical
-- RLS policy shape as every other tenant-scoped table. It also seeds the
-- two real commercial plans and backfills a subscription row for every
-- tenant that already exists, so "every tenant has exactly one
-- subscription" is true immediately after this migration runs — no
-- nullable "no plan assigned" state to handle anywhere in the app.

-- 1. Enums.
CREATE TYPE "PlanCode" AS ENUM ('BUSINESS', 'PRO', 'CUSTOM');
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED');
CREATE TYPE "UsageMetric" AS ENUM ('ORDERS', 'USERS', 'WAREHOUSES');

-- One new in-app notification type — a usage threshold (80/90/100%) was
-- crossed for a tenant (src/lib/entitlements/alerts.ts). Not used within
-- this same migration transaction (cf. 20260912000000_support_center,
-- which added `SUPPORT_TICKET` the identical way).
ALTER TYPE "NotificationType" ADD VALUE 'USAGE_LIMIT_ALERT';

-- 2. `plans` — global catalogue, no tenantId, no RLS (same posture as `tenants`).
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "code" "PlanCode" NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "installationPriceMad" DECIMAL(12,2) NOT NULL,
    "monthlyPriceMad" DECIMAL(12,2) NOT NULL,
    "maxOrdersPerMonth" INTEGER,
    "maxUsers" INTEGER,
    "maxWarehouses" INTEGER,
    "features" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- 3. `tenant_subscriptions` — one row per tenant.
CREATE TABLE "tenant_subscriptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "planId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentPlanSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trialEndsAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_subscriptions_tenantId_key" ON "tenant_subscriptions"("tenantId");
CREATE INDEX "tenant_subscriptions_planId_idx" ON "tenant_subscriptions"("planId");

ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tenant_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_subscriptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tenant_subscriptions"
    USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- 4. `usage_alert_states` — durable de-dup state for threshold alerts.
CREATE TABLE "usage_alert_states" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "metric" "UsageMetric" NOT NULL,
    "period" TEXT NOT NULL,
    "highestThresholdNotified" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_alert_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "usage_alert_states_tenantId_metric_period_key" ON "usage_alert_states"("tenantId", "metric", "period");
CREATE INDEX "usage_alert_states_tenantId_idx" ON "usage_alert_states"("tenantId");

ALTER TABLE "usage_alert_states" ADD CONSTRAINT "usage_alert_states_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "usage_alert_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "usage_alert_states" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "usage_alert_states"
    USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- 5. Composite index on `orders` for the monthly-usage count
--    (src/lib/entitlements/usage.ts) — one indexed range scan per tenant
--    per period regardless of total order volume across other tenants.
CREATE INDEX "orders_tenantId_placedAt_idx" ON "orders"("tenantId", "placedAt");

-- 6. Seed the two real commercial plans. Prices/limits/features live only
--    here and in src/lib/entitlements/catalogue.ts's validation schema —
--    never hardcoded anywhere else in the application. `gen_random_uuid()`
--    needs pgcrypto; Supabase/most managed Postgres already has it
--    enabled, but this repo's ids are cuids generated by Prisma at the
--    application layer everywhere else, so a fixed, readable id is used
--    here instead of depending on a Postgres extension in a migration.
INSERT INTO "plans" ("id", "code", "name", "isActive", "sortOrder", "installationPriceMad", "monthlyPriceMad", "maxOrdersPerMonth", "maxUsers", "maxWarehouses", "features", "createdAt", "updatedAt")
VALUES (
    'plan-business',
    'BUSINESS',
    'Business',
    true,
    0,
    1500.00,
    599.00,
    1500,
    7,
    3,
    '{"woocommerce": true, "shopify": true, "reports": "standard", "profitability": "standard", "backup": "standard", "aiAssistant": true, "integrations": true, "notifications": true, "commissions": true, "finance": true, "orders": true, "users": true, "warehouses": true, "support": "standard"}'::jsonb,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);

INSERT INTO "plans" ("id", "code", "name", "isActive", "sortOrder", "installationPriceMad", "monthlyPriceMad", "maxOrdersPerMonth", "maxUsers", "maxWarehouses", "features", "createdAt", "updatedAt")
VALUES (
    'plan-pro',
    'PRO',
    'Pro',
    true,
    1,
    2500.00,
    1000.00,
    7000,
    20,
    10,
    '{"woocommerce": true, "shopify": true, "reports": "advanced", "profitability": "advanced", "backup": "advanced", "aiAssistant": true, "integrations": true, "notifications": true, "commissions": true, "finance": true, "orders": true, "users": true, "warehouses": true, "support": "priority"}'::jsonb,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);

-- 7. Backfill: every tenant that already exists (the bootstrap tenant on
--    a fresh install, or every real tenant on an already-live shared
--    deployment) gets a BUSINESS/ACTIVE subscription — a safe, reversible
--    default a platform admin can change per tenant afterward via
--    /platform/plans. `gen_random_uuid()`-free id generation: a
--    deterministic id derived from the tenant id, unique by construction
--    since tenantId itself is unique.
INSERT INTO "tenant_subscriptions" ("id", "tenantId", "planId", "status", "currentPlanSince", "createdAt", "updatedAt")
SELECT
    'sub-' || "id",
    "id",
    'plan-business',
    'ACTIVE',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "tenants";
