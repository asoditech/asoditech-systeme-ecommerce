-- Backup Phase 2 — Google Drive as an external backup destination.
-- See docs/adr/0034-backup-and-portability.md §"Phase 2 — Google Drive".
--
-- Additive only. Reuses the Phase-1 `.asb` container and the entire
-- Phase-1 restore pipeline unchanged. Nothing about tenant isolation / RLS
-- changes except that two NEW tenant-scoped tables get the same policy
-- shape as every other one (docs/adr/0026-multi-tenant-rls.md).

-- 1. New backup-run kind + Drive metadata columns on the existing table.
ALTER TYPE "BackupRunType" ADD VALUE 'DRIVE_EXPORT';

ALTER TABLE "backup_runs" ADD COLUMN "driveFileId" TEXT;
ALTER TABLE "backup_runs" ADD COLUMN "driveFileName" TEXT;
ALTER TABLE "backup_runs" ADD COLUMN "driveUploadedAt" TIMESTAMP(3);

CREATE INDEX "backup_runs_tenantId_driveFileId_idx" ON "backup_runs"("tenantId", "driveFileId");

-- 2. Per-tenant Google Drive connection (encrypted OAuth tokens).
CREATE TABLE "google_drive_connections" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "status" "IntegrationStatus" NOT NULL DEFAULT 'DECONNECTE',
    "credentialsEncrypted" TEXT NOT NULL,
    "googleAccountEmail" TEXT,
    "driveFolderId" TEXT,
    "driveFolderName" TEXT,
    "lastBackupAt" TIMESTAMP(3),
    "lastConnectionCheckAt" TIMESTAMP(3),
    "lastError" TEXT,
    "connectedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_drive_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "google_drive_connections_tenantId_key" ON "google_drive_connections"("tenantId");
CREATE INDEX "google_drive_connections_tenantId_idx" ON "google_drive_connections"("tenantId");

ALTER TABLE "google_drive_connections" ADD CONSTRAINT "google_drive_connections_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "google_drive_connections" ADD CONSTRAINT "google_drive_connections_connectedById_fkey" FOREIGN KEY ("connectedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Short-lived, single-use, tenant+user-bound OAuth handshake state.
CREATE TABLE "google_oauth_states" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "redirectPath" TEXT NOT NULL DEFAULT '/parametres/sauvegarde',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "google_oauth_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "google_oauth_states_stateHash_key" ON "google_oauth_states"("stateHash");
CREATE INDEX "google_oauth_states_tenantId_idx" ON "google_oauth_states"("tenantId");
CREATE INDEX "google_oauth_states_expiresAt_idx" ON "google_oauth_states"("expiresAt");

ALTER TABLE "google_oauth_states" ADD CONSTRAINT "google_oauth_states_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "google_oauth_states" ADD CONSTRAINT "google_oauth_states_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. RLS — identical policy shape to every other tenant-scoped table.
ALTER TABLE "google_drive_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "google_drive_connections" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "google_drive_connections"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "google_oauth_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "google_oauth_states" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "google_oauth_states"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
