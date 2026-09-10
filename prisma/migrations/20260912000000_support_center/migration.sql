-- Support & Help Center — a new UX feature (floating support widget).
--
-- Additive only. Nothing about Orders / Delivery / Tracking / Finance /
-- Stock / WooCommerce / Aramex / OzonExpress / RBAC / multi-tenant
-- behaviour changes. This migration:
--   1. adds five optional support-contact columns to `business_settings`
--   2. adds one `NotificationType` value for a reported problem
--   3. adds one tenant-scoped table `support_tickets`, with the same RLS
--      policy shape as every other tenant-scoped table (docs/adr/0026).

-- 1. Support contact points on the tenant's business settings.
ALTER TABLE "business_settings"
    ADD COLUMN "supportName" TEXT,
    ADD COLUMN "supportWhatsapp" TEXT,
    ADD COLUMN "supportPhone" TEXT,
    ADD COLUMN "supportEmail" TEXT,
    ADD COLUMN "supportHours" TEXT;

-- 2. New in-app notification type — a problem reported from the widget.
ALTER TYPE "NotificationType" ADD VALUE 'SUPPORT_TICKET';

-- 3. Support tickets — a minimal persisted record now, room for a real
--    support queue later.
CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "reporterUserId" TEXT,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "pageUrl" TEXT,
    "contextType" TEXT,
    "contextId" TEXT,
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "support_tickets_tenantId_status_createdAt_idx" ON "support_tickets"("tenantId", "status", "createdAt");
CREATE INDEX "support_tickets_tenantId_idx" ON "support_tickets"("tenantId");

ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_reporterUserId_fkey" FOREIGN KEY ("reporterUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS — identical policy shape to every other tenant-scoped table.
ALTER TABLE "support_tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_tickets" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "support_tickets"
    USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
