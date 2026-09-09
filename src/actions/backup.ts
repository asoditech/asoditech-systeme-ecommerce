"use server";

import { revalidatePath } from "next/cache";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { actionError, actionOk, type ActionResult } from "@/actions/types";
import { runRestore, discardRestoreUpload } from "@/lib/backup/service";
import { BackupInspectionError, CrossTenantRestoreError } from "@/lib/backup/import";

/**
 * Server Actions for the Backup & Portability module
 * (docs/adr/0034-backup-and-portability.md).
 *
 * Generation and upload go through Route Handlers (binary payloads); these
 * actions carry only a tiny `uploadId`. All are gated on `settings.manage`
 * (OWNER / ADMIN — see src/lib/auth/permissions.ts).
 */

const PATH = "/parametres/sauvegarde";

export async function confirmRestoreAction(
  formData: FormData
): Promise<ActionResult<{ safetySnapshotId: string; restoredTotal: number; usersCreatedDisabled: number }>> {
  const user = await requirePermissionForAction("settings.manage");
  const uploadId = String(formData.get("uploadId") ?? "").trim();
  if (!uploadId) return actionError("Aucune sauvegarde à restaurer.");

  try {
    const { result, safetySnapshotId } = await runRestore({
      tenantId: user.tenantId,
      userId: user.id,
      uploadId,
    });
    revalidatePath(PATH);
    return actionOk({
      safetySnapshotId,
      restoredTotal: Object.values(result.restoredCounts).reduce((a, b) => a + b, 0),
      usersCreatedDisabled: result.usersCreatedDisabled,
    });
  } catch (err) {
    revalidatePath(PATH);
    if (err instanceof CrossTenantRestoreError || err instanceof BackupInspectionError) {
      return actionError(err.message);
    }
    return actionError(
      err instanceof Error
        ? `Restauration annulée : ${err.message}. Vos données actuelles sont intactes.`
        : "Restauration annulée. Vos données actuelles sont intactes."
    );
  }
}

export async function discardRestoreUploadAction(formData: FormData): Promise<ActionResult<undefined>> {
  const user = await requirePermissionForAction("settings.manage");
  const uploadId = String(formData.get("uploadId") ?? "").trim();
  if (uploadId) {
    await discardRestoreUpload({ tenantId: user.tenantId, userId: user.id, uploadId });
  }
  revalidatePath(PATH);
  return actionOk(undefined);
}
