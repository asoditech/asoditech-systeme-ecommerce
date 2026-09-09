-- Backup & Portability — Phase 1. See docs/adr/0034-backup-and-portability.md.
--
-- An INDEPENDENT module. This migration adds exactly ONE tenant-scoped
-- table (`backup_runs`) and its two enums. It changes nothing about
-- Orders / Stock / Delivery / Finance / RBAC / multi-tenant behaviour, and
-- touches no existing table.
--
-- `backup_runs` gets the same RLS policy shape as every other tenant-scoped
-- table (docs/adr/0026-multi-tenant-rls.md) so a tenant can only ever see
-- or write its own backup rows — enforced at the database, not just in the
-- app layer.

CREATE TYPE "BackupRunType" AS ENUM ('MANUAL_EXPORT', 'PRE_RESTORE_SNAPSHOT', 'RESTORE_UPLOAD');
CREATE TYPE "BackupRunStatus" AS ENUM ('PENDING', 'READY', 'RESTORED', 'FAILED', 'EXPIRED');

CREATE TABLE "backup_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "type" "BackupRunType" NOT NULL,
    "status" "BackupRunStatus" NOT NULL DEFAULT 'PENDING',
    "formatVersion" INTEGER NOT NULL,
    "appVersion" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "counts" JSONB NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "checksumSha256" TEXT NOT NULL DEFAULT '',
    "payload" BYTEA,
    "error" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "backup_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "backup_runs_tenantId_type_createdAt_idx" ON "backup_runs"("tenantId", "type", "createdAt");
CREATE INDEX "backup_runs_tenantId_idx" ON "backup_runs"("tenantId");

ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS — identical policy shape to every other tenant-scoped table.
ALTER TABLE "backup_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "backup_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "backup_runs"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
