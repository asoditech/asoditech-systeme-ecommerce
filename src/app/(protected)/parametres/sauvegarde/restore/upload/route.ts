import { getCurrentUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { MAX_CONTAINER_BYTES } from "@/lib/backup/constants";
import { storeRestoreUpload } from "@/lib/backup/service";
import { BackupInspectionError } from "@/lib/backup/import";
import { BACKUP_MODELS_BY_KEY } from "@/lib/backup/models";

/**
 * Restore upload endpoint (docs/adr/0034-backup-and-portability.md).
 *
 * `POST` multipart/form-data with field `file` → validate the package,
 * hold it server-side (a `RESTORE_UPLOAD` row), and return a JSON preview.
 * The actual restore is a separate, explicitly-confirmed Server Action
 * (`confirmRestoreAction`) that references the returned `uploadId`.
 *
 * A Route Handler (not a Server Action) so the multi-MB binary body is not
 * subject to the Server Action body-size limit.
 */

export async function POST(request: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Non authentifié." }, { status: 401 });
  if (!hasPermission(user.role, "settings.manage")) {
    return Response.json({ error: "Permission « settings.manage » requise." }, { status: 403 });
  }

  let file: File | null = null;
  try {
    const form = await request.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return Response.json({ error: "Requête invalide." }, { status: 400 });
  }
  if (!file) return Response.json({ error: "Aucun fichier fourni." }, { status: 400 });
  if (file.size > MAX_CONTAINER_BYTES) {
    return Response.json(
      { error: `Fichier trop volumineux (max ${(MAX_CONTAINER_BYTES / 1024 / 1024).toFixed(0)} Mo).` },
      { status: 413 }
    );
  }

  const container = Buffer.from(await file.arrayBuffer());

  try {
    const { uploadId, inspected } = await storeRestoreUpload({
      tenantId: user.tenantId,
      userId: user.id,
      container,
    });

    return Response.json({
      uploadId,
      valid: inspected.valid,
      errors: inspected.errors,
      warnings: inspected.warnings,
      totalRows: inspected.totalRows,
      manifest: {
        format: inspected.manifest?.format ?? null,
        version: inspected.manifest?.version ?? null,
        createdAt: inspected.manifest?.createdAt ?? null,
        appVersion: inspected.manifest?.appVersion ?? null,
        schemaVersion: inspected.manifest?.schemaVersion ?? null,
        tenant: inspected.manifest?.tenant ?? null,
        sameTenant: inspected.manifest?.tenant?.id === user.tenantId,
      },
      preview: Object.entries(inspected.counts)
        .filter(([, n]) => n > 0)
        .map(([key, n]) => ({ label: BACKUP_MODELS_BY_KEY.get(key)?.model ?? key, count: n }))
        .sort((a, b) => b.count - a.count),
    });
  } catch (err) {
    if (err instanceof BackupInspectionError) {
      return Response.json({ error: err.message }, { status: 422 });
    }
    console.error("[backup] upload inspection failed", err);
    return Response.json({ error: "Échec de l'analyse du fichier." }, { status: 500 });
  }
}
