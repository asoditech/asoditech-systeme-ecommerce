import { getCurrentUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { recordAuditEvent } from "@/lib/audit";
import { runWithTenant } from "@/lib/tenant/context";
import { downloadDriveBackup } from "@/lib/backup/google-drive-service";
import { GoogleDriveAuthError, GoogleDriveApiError, GoogleDriveConfigError } from "@/lib/backup/google-drive";

/**
 * Streams one of THIS tenant's Google Drive backups to the browser
 * (Backup Phase 2 — docs/adr/0034 §"Phase 2").
 *
 * `GET ?ref=<BackupRun id>` — `ref` is resolved to a tenant-scoped
 * BackupRun record (RLS), then re-verified server-side to be inside this
 * tenant's own Drive folder before a single byte is read; the bytes are
 * size-capped and magic-checked in the service. `settings.manage` only.
 */
export async function GET(request: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return new Response("Non authentifié.", { status: 401 });
  if (!hasPermission(user.role, "settings.manage")) {
    return new Response("Permission « settings.manage » requise.", { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const ref = params.get("ref") ?? params.get("fileId");
  if (!ref) return new Response("Paramètre ref manquant.", { status: 400 });

  try {
    const { bytes, filename } = await downloadDriveBackup({ tenantId: user.tenantId, userId: user.id, ref });
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename.replace(/[^\w.\-]+/g, "_")}"`,
        "Content-Length": String(bytes.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (!(err instanceof GoogleDriveAuthError)) {
      await runWithTenant(user.tenantId, "backup:drive", () =>
        recordAuditEvent({
          actorType: "USER",
          actorUserId: user.id,
          action: "backup.drive_operation_failed",
          entityType: "GoogleDriveConnection",
          entityId: user.tenantId,
          metadata: { operation: "download", error: (err instanceof Error ? err.message : "").slice(0, 200) },
        })
      ).catch(() => {});
    }
    if (err instanceof GoogleDriveAuthError) return new Response(err.message, { status: 409 });
    if (err instanceof GoogleDriveConfigError) return new Response(err.message, { status: 409 });
    if (err instanceof GoogleDriveApiError) return new Response(err.message, { status: 502 });
    console.error("[backup] drive download failed");
    return new Response("Le téléchargement depuis Google Drive a échoué.", { status: 500 });
  }
}
