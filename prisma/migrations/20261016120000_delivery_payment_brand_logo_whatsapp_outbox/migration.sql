-- Delivery = paid option, in-app company logo grant, WhatsApp alerts outbox.
-- PREPARED, NOT APPLIED (2026-10-16): needs the owner's approval before any
-- `prisma migrate deploy` on any database.
--
-- Additive only — no existing row, column or constraint is rewritten:
--  - business_settings.autoPaidOnDelivery: « Marquer automatiquement les
--    commandes comme payées à la livraison », default OFF for every company.
--  - business_settings.whatsappDisabledAlerts: WhatsApp alert categories the
--    company switched off, default empty (= unchanged behaviour).
--  - tenants.brandLogoGranted: platform-controlled, default OFF (= ASODITECH
--    branding in the app shell, unchanged).
--  - whatsapp_outbox: new, empty tenant-scoped table (one row per business
--    event and recipient; idempotent through its unique key).
--
-- Grants: the runtime role receives privileges on the new table through the
-- existing ALTER DEFAULT PRIVILEGES, as long as this migration runs as the
-- same migration role (same note as 20261010120000_auth_rate_limits).

-- AlterTable
ALTER TABLE "business_settings" ADD COLUMN "autoPaidOnDelivery" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "business_settings" ADD COLUMN "whatsappDisabledAlerts" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "brandLogoGranted" BOOLEAN NOT NULL DEFAULT false;

-- CreateEnum
CREATE TYPE "WhatsAppOutboxStatus" AS ENUM ('EN_ATTENTE', 'EN_COURS', 'ENVOYE', 'ECHEC', 'IGNORE');

-- CreateTable
CREATE TABLE "whatsapp_outbox" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT NOT NULL,
    "alertType" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "templateName" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WhatsAppOutboxStatus" NOT NULL DEFAULT 'EN_ATTENTE',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "providerMessageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_outbox_tenantId_userId_dedupeKey_key" ON "whatsapp_outbox"("tenantId", "userId", "dedupeKey");

-- CreateIndex
CREATE INDEX "whatsapp_outbox_tenantId_status_nextAttemptAt_idx" ON "whatsapp_outbox"("tenantId", "status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "whatsapp_outbox_tenantId_createdAt_idx" ON "whatsapp_outbox"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "whatsapp_outbox" ADD CONSTRAINT "whatsapp_outbox_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_outbox" ADD CONSTRAINT "whatsapp_outbox_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS — identical policy shape to every other tenant-scoped table.
ALTER TABLE "whatsapp_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_outbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "whatsapp_outbox"
    USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
