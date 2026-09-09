import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { recordAuditEvent } from "@/lib/audit";
import { BACKUP_FORMAT_VERSION, RESTORE_UPLOAD_TTL_MS, SAFETY_SNAPSHOT_TTL_MS } from "./constants";
import { APP_VERSION, SCHEMA_VERSION } from "./manifest";
import { buildTenantBackup } from "./export";
import {
  inspectBackup,
  restoreTenantBackup,
  BackupInspectionError,
  type InspectedBackup,
  type RestoreResult,
} from "./import";

/**
 * DB-facing orchestration for the Backup & Portability module
 * (docs/adr/0034-backup-and-portability.md). Every function runs inside a
 * `runWithTenant` directive so both the app-level tenant extension and the
 * DB-level RLS policy on `backup_runs` scope every write to the caller's
 * own tenant.
 */

function baseRunFields(counts: Record<string, number>): Pick<
  Prisma.BackupRunUncheckedCreateInput,
  "formatVersion" | "appVersion" | "schemaVersion" | "counts"
> {
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    counts: counts as Prisma.InputJsonValue,
  };
}

export interface ManualBackupResult {
  runId: string;
  container: Buffer;
  filename: string;
  counts: Record<string, number>;
  sizeBytes: number;
}

function backupFilename(slug: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const safeSlug = slug.replace(/[^a-z0-9-]+/gi, "-").toLowerCase() || "tenant";
  return `ASODITECH_BACKUP_${safeSlug}_${date}.asb`;
}

/** Generate a fresh backup, persist it as the tenant's single retained
 * MANUAL_EXPORT, and hand back the container for download. */
export async function createManualBackup(params: {
  tenantId: string;
  userId: string;
  slug: string;
}): Promise<ManualBackupResult> {
  return runWithTenant(params.tenantId, "backup:service", async () => {
    const backup = await buildTenantBackup({ tenantId: params.tenantId, createdByUserId: params.userId });

    // Keep only the latest manual export — drop the payload bytes of any
    // prior one so the table never accumulates full tenant copies.
    await prisma.backupRun.deleteMany({ where: { type: "MANUAL_EXPORT" } });

    const run = await prisma.backupRun.create({
      data: {
        ...baseRunFields(backup.counts),
        type: "MANUAL_EXPORT",
        status: "READY",
        sizeBytes: backup.sizeBytes,
        checksumSha256: backup.manifest.checksum.data,
        payload: new Uint8Array(backup.container),
        createdById: params.userId,
      },
      select: { id: true },
    });

    await recordAuditEvent({
      actorType: "USER",
      actorUserId: params.userId,
      action: "backup.created",
      entityType: "BackupRun",
      entityId: run.id,
      metadata: { totalRows: backup.manifest.totalRows, sizeBytes: backup.sizeBytes },
    });

    return {
      runId: run.id,
      container: backup.container,
      filename: backupFilename(params.slug),
      counts: backup.counts,
      sizeBytes: backup.sizeBytes,
    };
  });
}

/** The stored, re-downloadable latest manual backup (or null). */
export async function getDownloadableBackup(params: {
  tenantId: string;
  slug: string;
}): Promise<{ runId: string; container: Buffer; filename: string } | null> {
  return runWithTenant(params.tenantId, "backup:service", async () => {
    const run = await prisma.backupRun.findFirst({
      where: { type: "MANUAL_EXPORT", status: "READY", payload: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { id: true, payload: true },
    });
    if (!run?.payload) return null;
    return { runId: run.id, container: Buffer.from(run.payload), filename: backupFilename(params.slug) };
  });
}

export interface StoredUpload {
  uploadId: string;
  inspected: InspectedBackup;
}

/** Validate an uploaded package and hold it server-side between the restore
 * "preview" and "confirm" steps. Throws `BackupInspectionError` if the file
 * can't even be parsed; a decryptable-but-invalid package is stored so the
 * preview can show WHY it was rejected. */
export async function storeRestoreUpload(params: {
  tenantId: string;
  userId: string;
  container: Buffer;
}): Promise<StoredUpload> {
  const inspected = inspectBackup(params.container); // may throw BackupInspectionError

  return runWithTenant(params.tenantId, "backup:service", async () => {
    // At most one pending upload at a time — discard any earlier one.
    await prisma.backupRun.deleteMany({ where: { type: "RESTORE_UPLOAD", status: { in: ["PENDING", "FAILED"] } } });

    const run = await prisma.backupRun.create({
      data: {
        ...baseRunFields(inspected.counts),
        type: "RESTORE_UPLOAD",
        status: "PENDING",
        sizeBytes: params.container.length,
        checksumSha256: inspected.manifest?.checksum?.data ?? "",
        payload: new Uint8Array(params.container),
        createdById: params.userId,
        expiresAt: new Date(Date.now() + RESTORE_UPLOAD_TTL_MS),
        error: inspected.valid ? null : inspected.errors.join(" | "),
      },
      select: { id: true },
    });

    await recordAuditEvent({
      actorType: "USER",
      actorUserId: params.userId,
      action: "backup.restore_previewed",
      entityType: "BackupRun",
      entityId: run.id,
      metadata: { valid: inspected.valid, totalRows: inspected.totalRows },
    });

    return { uploadId: run.id, inspected };
  });
}

export async function discardRestoreUpload(params: {
  tenantId: string;
  userId: string;
  uploadId: string;
}): Promise<void> {
  await runWithTenant(params.tenantId, "backup:service", async () => {
    await prisma.backupRun.deleteMany({ where: { id: params.uploadId, type: "RESTORE_UPLOAD" } });
  });
}

export interface RunRestoreOutcome {
  result: RestoreResult;
  safetySnapshotId: string;
}

/**
 * Execute a restore from a previously-stored RESTORE_UPLOAD:
 *   1. re-decrypt + re-validate the stored package (never trust a stored verdict);
 *   2. take a PRE_RESTORE_SNAPSHOT of the tenant's CURRENT data;
 *   3. run the transactional wipe+reinsert;
 *   4. mark the upload RESTORED and drop its payload.
 * On any failure the transaction rolls back, the upload is marked FAILED,
 * and the safety snapshot remains downloadable.
 */
export async function runRestore(params: {
  tenantId: string;
  userId: string;
  uploadId: string;
}): Promise<RunRestoreOutcome> {
  return runWithTenant(params.tenantId, "backup:service", async () => {
    const upload = await prisma.backupRun.findFirst({
      where: { id: params.uploadId, type: "RESTORE_UPLOAD", status: "PENDING", payload: { not: null } },
      select: { id: true, payload: true },
    });
    if (!upload?.payload) {
      throw new BackupInspectionError("Aucune sauvegarde en attente de restauration (expirée ou déjà utilisée).");
    }

    const inspected = inspectBackup(Buffer.from(upload.payload));
    if (!inspected.valid) {
      await prisma.backupRun.update({
        where: { id: upload.id },
        data: { status: "FAILED", error: inspected.errors.join(" | "), payload: null },
      });
      throw new BackupInspectionError(`Sauvegarde invalide : ${inspected.errors.join(" ; ")}`);
    }

    // 2 — safety snapshot of CURRENT data.
    const snapshot = await buildTenantBackup({ tenantId: params.tenantId, createdByUserId: params.userId });
    const safety = await prisma.backupRun.create({
      data: {
        ...baseRunFields(snapshot.counts),
        type: "PRE_RESTORE_SNAPSHOT",
        status: "READY",
        sizeBytes: snapshot.sizeBytes,
        checksumSha256: snapshot.manifest.checksum.data,
        payload: new Uint8Array(snapshot.container),
        createdById: params.userId,
        note: `Instantané de sécurité avant restauration de ${params.uploadId}`,
        expiresAt: new Date(Date.now() + SAFETY_SNAPSHOT_TTL_MS),
      },
      select: { id: true },
    });

    try {
      const result = await restoreTenantBackup({ activeTenantId: params.tenantId, inspected });

      await prisma.backupRun.update({
        where: { id: upload.id },
        data: { status: "RESTORED", payload: null },
      });
      await recordAuditEvent({
        actorType: "USER",
        actorUserId: params.userId,
        action: "backup.restored",
        entityType: "BackupRun",
        entityId: upload.id,
        metadata: {
          safetySnapshotId: safety.id,
          restoredTotal: Object.values(result.restoredCounts).reduce((a, b) => a + b, 0),
          usersCreatedDisabled: result.usersCreatedDisabled,
          usersUpdated: result.usersUpdated,
          auditEventsAppended: result.auditEventsAppended,
        },
      });

      return { result, safetySnapshotId: safety.id };
    } catch (err) {
      await prisma.backupRun.update({
        where: { id: upload.id },
        data: { status: "FAILED", error: err instanceof Error ? err.message.slice(0, 500) : "Erreur inconnue", payload: null },
      });
      await recordAuditEvent({
        actorType: "USER",
        actorUserId: params.userId,
        action: "backup.restore_failed",
        entityType: "BackupRun",
        entityId: upload.id,
        metadata: { safetySnapshotId: safety.id, error: err instanceof Error ? err.message.slice(0, 300) : "unknown" },
      });
      throw err;
    }
  });
}
