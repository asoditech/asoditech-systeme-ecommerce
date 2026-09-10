import "server-only";

import { prisma } from "@/lib/prisma";
import { BACKUP_MODELS_BY_KEY } from "@/lib/backup/models";
import {
  getDriveConnectionView,
  listDriveBackups,
  type DriveConnectionView,
  type DriveBackupItem,
} from "@/lib/backup/google-drive-service";

/**
 * Read model for the « Sauvegarde & Portabilité » settings page. Tenant
 * scoping is automatic (the tenant-scoped `prisma` client + RLS on
 * `backup_runs`).
 */

export interface BackupStatusView {
  lastBackup: {
    id: string;
    createdAt: string;
    createdByName: string | null;
    sizeBytes: number;
    totalRows: number;
    schemaVersion: string;
    appVersion: string;
    /** Non-zero per-model counts, prettified, largest first. */
    breakdown: { label: string; count: number }[];
    downloadable: boolean;
  } | null;
  pendingUpload: {
    id: string;
    createdAt: string;
    totalRows: number;
    valid: boolean;
    error: string | null;
  } | null;
  recentSafetySnapshots: {
    id: string;
    createdAt: string;
    sizeBytes: number;
    expiresAt: string | null;
    downloadable: boolean;
  }[];
  /** Phase 2 — Google Drive. `connection.configured` is false when the
   * deployment has no Google OAuth client; every Drive control is hidden. */
  googleDrive: {
    connection: DriveConnectionView;
    backups: DriveBackupItem[];
    listError: string | null;
  };
}

function countsToBreakdown(counts: unknown): { label: string; count: number }[] {
  if (!counts || typeof counts !== "object") return [];
  return Object.entries(counts as Record<string, number>)
    .filter(([, n]) => typeof n === "number" && n > 0)
    .map(([key, n]) => ({ label: BACKUP_MODELS_BY_KEY.get(key)?.model ?? key, count: n }))
    .sort((a, b) => b.count - a.count);
}

function totalOf(counts: unknown): number {
  if (!counts || typeof counts !== "object") return 0;
  return Object.values(counts as Record<string, number>).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);
}

export async function getBackupStatus(tenantId: string): Promise<BackupStatusView> {
  const [manual, pending, snapshots, driveConn] = await Promise.all([
    prisma.backupRun.findFirst({
      where: { type: "MANUAL_EXPORT" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        createdAt: true,
        sizeBytes: true,
        counts: true,
        schemaVersion: true,
        appVersion: true,
        payload: true,
        createdBy: { select: { name: true } },
      },
    }),
    prisma.backupRun.findFirst({
      where: { type: "RESTORE_UPLOAD", status: "PENDING" },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true, counts: true, error: true },
    }),
    prisma.backupRun.findMany({
      where: { type: "PRE_RESTORE_SNAPSHOT" },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, createdAt: true, sizeBytes: true, expiresAt: true, payload: true },
    }),
    getDriveConnectionView(tenantId),
  ]);

  // Only hit the Drive API when actually connected — and never let a Drive
  // outage break the settings page.
  let driveBackups: DriveBackupItem[] = [];
  let driveListError: string | null = null;
  if (driveConn.connected) {
    try {
      driveBackups = await listDriveBackups(tenantId);
    } catch (err) {
      driveListError = err instanceof Error ? err.message : "Liste Google Drive indisponible.";
    }
  }

  return {
    lastBackup: manual
      ? {
          id: manual.id,
          createdAt: manual.createdAt.toISOString(),
          createdByName: manual.createdBy?.name ?? null,
          sizeBytes: manual.sizeBytes,
          totalRows: totalOf(manual.counts),
          schemaVersion: manual.schemaVersion,
          appVersion: manual.appVersion,
          breakdown: countsToBreakdown(manual.counts),
          downloadable: manual.payload != null,
        }
      : null,
    pendingUpload: pending
      ? {
          id: pending.id,
          createdAt: pending.createdAt.toISOString(),
          totalRows: totalOf(pending.counts),
          valid: pending.error == null,
          error: pending.error,
        }
      : null,
    recentSafetySnapshots: snapshots.map((s) => ({
      id: s.id,
      createdAt: s.createdAt.toISOString(),
      sizeBytes: s.sizeBytes,
      expiresAt: s.expiresAt?.toISOString() ?? null,
      downloadable: s.payload != null,
    })),
    googleDrive: { connection: driveConn, backups: driveBackups, listError: driveListError },
  };
}
