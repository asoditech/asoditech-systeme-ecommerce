"use server";

import { revalidatePath } from "next/cache";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { recordAuditEvent } from "@/lib/audit";
import { actionError, actionOk, type ActionResult } from "@/actions/types";
import type { CurrentUser } from "@/lib/auth/session";
import { buildRestorePreviewResponse, type RestorePreviewResponse } from "@/lib/backup/service";
import {
  startGoogleOAuth,
  disconnectGoogleDrive,
  pushBackupToDrive,
  deleteDriveBackup,
  prepareRestoreFromDrive,
  isGoogleDriveConfigured,
  GoogleDriveConfigError,
  GoogleDriveAuthError,
  GoogleDriveApiError,
} from "@/lib/backup/google-drive-service";
import { BackupInspectionError } from "@/lib/backup/import";

/**
 * Server Actions for Backup Phase 2 — Google Drive (docs/adr/0034 §"Phase 2").
 * All gated on `settings.manage` (OWNER / ADMIN). Binary transfer (the
 * `.asb` upload/download) happens server-side inside the service; these
 * actions only carry ids and return small JSON. Tokens never appear in any
 * return value.
 */

const PATH = "/parametres/sauvegarde";

function friendly(err: unknown): string {
  if (
    err instanceof GoogleDriveConfigError ||
    err instanceof GoogleDriveAuthError ||
    err instanceof GoogleDriveApiError ||
    err instanceof BackupInspectionError
  ) {
    return err.message;
  }
  return "Opération Google Drive impossible pour le moment.";
}

/** Record a `backup.drive_operation_failed` audit event for a failed Drive
 * operation (spec §8 — success AND failure are audited). Never contains a
 * token or a raw Google error body. A token-revocation failure is already
 * audited as `backup.drive_token_error` — don't double-log it. */
async function auditDriveFailure(user: CurrentUser, operation: string, err: unknown): Promise<void> {
  if (err instanceof GoogleDriveAuthError) return;
  await runWithTenant(user.tenantId, "backup:drive", () =>
    recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "backup.drive_operation_failed",
      entityType: "GoogleDriveConnection",
      entityId: user.tenantId,
      metadata: { operation, error: friendly(err).slice(0, 200) },
    })
  ).catch(() => {});
}

export async function startGoogleDriveConnectAction(): Promise<ActionResult<{ authUrl: string }>> {
  const user = await requirePermissionForAction("settings.manage");
  if (!isGoogleDriveConfigured()) return actionError("Google Drive n'est pas configuré sur ce déploiement.");
  try {
    const { authUrl } = await startGoogleOAuth({ tenantId: user.tenantId, userId: user.id });
    return actionOk({ authUrl });
  } catch (err) {
    await auditDriveFailure(user, "connect_start", err);
    return actionError(friendly(err));
  }
}

export async function disconnectGoogleDriveAction(): Promise<ActionResult<undefined>> {
  const user = await requirePermissionForAction("settings.manage");
  try {
    await disconnectGoogleDrive({ tenantId: user.tenantId, userId: user.id });
  } catch (err) {
    await auditDriveFailure(user, "disconnect", err);
    revalidatePath(PATH);
    return actionError(friendly(err));
  }
  revalidatePath(PATH);
  return actionOk(undefined);
}

export async function pushBackupToDriveAction(): Promise<
  ActionResult<{ name: string; sizeBytes: number; totalRows: number }>
> {
  const user = await requirePermissionForAction("settings.manage");
  const tenant = await runWithTenant(user.tenantId, "backup:drive", () =>
    prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId }, select: { slug: true } })
  );
  try {
    const res = await pushBackupToDrive({ tenantId: user.tenantId, userId: user.id, slug: tenant.slug });
    revalidatePath(PATH);
    return actionOk({ name: res.name, sizeBytes: res.sizeBytes, totalRows: res.totalRows });
  } catch (err) {
    await auditDriveFailure(user, "upload", err);
    revalidatePath(PATH);
    return actionError(friendly(err));
  }
}

export async function deleteDriveBackupAction(formData: FormData): Promise<ActionResult<undefined>> {
  const user = await requirePermissionForAction("settings.manage");
  const ref = String(formData.get("ref") ?? formData.get("fileId") ?? "").trim();
  if (!ref) return actionError("Sauvegarde introuvable.");
  try {
    await deleteDriveBackup({ tenantId: user.tenantId, userId: user.id, ref });
    revalidatePath(PATH);
    return actionOk(undefined);
  } catch (err) {
    await auditDriveFailure(user, "delete", err);
    revalidatePath(PATH);
    return actionError(friendly(err));
  }
}

/** Downloads the chosen Drive backup server-side and hands it to the
 * EXISTING Phase-1 restore pipeline — returns the same preview shape as the
 * file-upload route so the client reuses its confirm dialog + the existing
 * `confirmRestoreAction`. */
export async function restoreFromDriveAction(
  formData: FormData
): Promise<ActionResult<RestorePreviewResponse>> {
  const user = await requirePermissionForAction("settings.manage");
  const ref = String(formData.get("ref") ?? formData.get("fileId") ?? "").trim();
  if (!ref) return actionError("Sauvegarde introuvable.");
  try {
    const stored = await prepareRestoreFromDrive({ tenantId: user.tenantId, userId: user.id, ref });
    revalidatePath(PATH);
    return actionOk(buildRestorePreviewResponse(stored, user.tenantId));
  } catch (err) {
    await auditDriveFailure(user, "restore_download", err);
    revalidatePath(PATH);
    return actionError(friendly(err));
  }
}
