-- Offers the CUSTOM plan (docs/adr/0035) for real: an unlimited, no-cost
-- bespoke plan for hand-picked tenants a platform admin assigns directly
-- (internal/family/friends use, or a negotiated customer) — never
-- self-serve, never advertised. `PlanCode.CUSTOM` and every code path
-- that reads a `Plan` row already handled this case (null limit =
-- unlimited, docs/adr/0035 "Usage metering"); only the seed row and the
-- platform-admin UI's own guardrails were withholding it (see
-- src/lib/entitlements/plan.ts's `listAllPlans`, tenant-plan-dialog.tsx).
--
-- Same seeding pattern as the BUSINESS/PRO rows in
-- 20260912010000_plans_entitlements_usage/migration.sql.
INSERT INTO "plans" ("id", "code", "name", "isActive", "sortOrder", "installationPriceMad", "monthlyPriceMad", "maxOrdersPerMonth", "maxUsers", "maxWarehouses", "features", "createdAt", "updatedAt")
VALUES (
    'plan-custom',
    'CUSTOM',
    'Illimité',
    true,
    2,
    0.00,
    0.00,
    NULL,
    NULL,
    NULL,
    '{"woocommerce": true, "shopify": true, "reports": "advanced", "profitability": "advanced", "backup": "advanced", "aiAssistant": true, "integrations": true, "notifications": true, "commissions": true, "finance": true, "orders": true, "users": true, "warehouses": true, "support": "priority"}'::jsonb,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);
