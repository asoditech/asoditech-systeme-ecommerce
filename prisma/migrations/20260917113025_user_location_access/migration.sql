-- Location Access Management v1 — see docs/adr/0037-location-access-management.md.
--
-- Warehouse remains the only physical-location entity (no new Location/Store
-- model — see that ADR). This migration adds ONLY the missing piece: which
-- users may operate on which Warehouse rows.
--
-- OWNER/ADMIN never need a row here (see hasGlobalLocationAccess() in
-- src/lib/auth/location-access.ts) — tenant-wide access comes from `role`
-- alone. Every other role's access is defined ENTIRELY by this table: zero
-- rows means zero warehouse access (safe default-deny).

-- 1. user_locations
CREATE TABLE "user_locations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "user_locations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_locations_tenantId_idx" ON "user_locations"("tenantId");
CREATE INDEX "user_locations_warehouseId_idx" ON "user_locations"("warehouseId");
CREATE UNIQUE INDEX "user_locations_userId_warehouseId_key" ON "user_locations"("userId", "warehouseId");

ALTER TABLE "user_locations" ADD CONSTRAINT "user_locations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Cascade: an assignment row is meaningless once the user it authorizes is
-- gone — same convention as sessions/password_reset_tokens (both onDelete:
-- Cascade on userId), not a business record worth preserving.
ALTER TABLE "user_locations" ADD CONSTRAINT "user_locations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Restrict, matching every other FK to warehouses (inventory_items,
-- stock_transfers, stocktake_sessions, ...) — a location is deactivated,
-- never deleted (docs/adr/0019), so this never actually blocks anything in
-- practice; it's here for the same defense-in-depth reason as the rest.
ALTER TABLE "user_locations" ADD CONSTRAINT "user_locations_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_locations" ADD CONSTRAINT "user_locations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS — identical policy shape to every other tenant-scoped table
-- (docs/adr/0026).
ALTER TABLE "user_locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_locations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "user_locations"
    USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- 2. Backfill — preserve current production behaviour on rollout.
--    Every existing non-OWNER/non-ADMIN user gets an explicit assignment to
--    every warehouse that already exists in THEIR OWN tenant, so nobody is
--    suddenly locked out of a warehouse they could already operate on
--    yesterday. OWNER/ADMIN are skipped — they need no row (global access
--    by role). This is a ONE-TIME backfill of the migration's own moment:
--    a warehouse created after this migration runs does NOT retroactively
--    grant itself to every user (see createWarehouseAction — no such
--    auto-grant), and a user created after this migration starts with zero
--    assignments (explicit assignment is the standing policy from here on).
--    `gen_random_uuid()`-free id generation, same convention as
--    20260912010000_plans_entitlements_usage: a deterministic id derived
--    from the (userId, warehouseId) pair, unique by construction since
--    that pair itself is unique.
INSERT INTO "user_locations" ("id", "tenantId", "userId", "warehouseId", "createdAt")
SELECT
    'ul-' || u."id" || '-' || w."id",
    u."tenantId",
    u."id",
    w."id",
    CURRENT_TIMESTAMP
FROM "users" u
JOIN "warehouses" w ON w."tenantId" = u."tenantId"
WHERE u."role" NOT IN ('OWNER', 'ADMIN')
ON CONFLICT ("userId", "warehouseId") DO NOTHING;
