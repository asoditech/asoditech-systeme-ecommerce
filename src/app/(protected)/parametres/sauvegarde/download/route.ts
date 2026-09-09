import { getCurrentUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { recordAuditEvent } from "@/lib/audit";
import { BACKUP_FILE_EXTENSION } from "@/lib/backup/constants";
import { createManualBackup, getDownloadableBackup } from "@/lib/backup/service";
import { BackupContainerError } from "@/lib/backup/container";
import { BackupTooLargeError } from "@/lib/backup/export";

/**
 * Backup download endpoint (docs/adr/0034-backup-and-portability.md).
 *
 *   POST                 → "Sauvegarder maintenant": generate a fresh
 *                          package, persist it as the tenant's retained
 *                          backup, stream it as an attachment.
 *   GET                  → re-download the latest generated package.
 *   GET ?snapshot=<id>   → download a specific pre-restore safety snapshot.
 *
 * Route Handlers are NOT wrapped by the (protected) layout — this does its
 * own auth. `settings.manage` (OWNER / ADMIN) only: a backup is a full copy
 * of the tenant's business data.
 */

function fileHeaders(filename: string, length: number): HeadersInit {
  return {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": String(length),
    "Cache-Control": "no-store",
  };
}

async function authorize() {
  const user = await getCurrentUser();
  if (!user) return { error: new Response("Non authentifié.", { status: 401 }) };
  if (!hasPermission(user.role, "settings.manage")) {
    return { error: new Response("Permission « settings.manage » requise.", { status: 403 }) };
  }
  return { user };
}

export async function POST(): Promise<Response> {
  const auth = await authorize();
  if (auth.error) return auth.error;
  const { user } = auth;

  const tenant = await runWithTenant(user.tenantId, "backup:download", () =>
    prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId }, select: { slug: true } })
  );

  try {
    const backup = await createManualBackup({ tenantId: user.tenantId, userId: user.id, slug: tenant.slug });
    return new Response(new Uint8Array(backup.container), {
      status: 200,
      headers: fileHeaders(backup.filename, backup.container.length),
    });
  } catch (err) {
    if (err instanceof BackupTooLargeError || err instanceof BackupContainerError) {
      return new Response(err.message, { status: 422 });
    }
    console.error("[backup] generation failed", err);
    return new Response("Échec de la génération de la sauvegarde.", { status: 500 });
  }
}

export async function GET(request: Request): Promise<Response> {
  const auth = await authorize();
  if (auth.error) return auth.error;
  const { user } = auth;

  const tenant = await runWithTenant(user.tenantId, "backup:download", () =>
    prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId }, select: { slug: true } })
  );

  const snapshotId = new URL(request.url).searchParams.get("snapshot");
  if (snapshotId) {
    const snap = await runWithTenant(user.tenantId, "backup:download", () =>
      prisma.backupRun.findFirst({
        where: { id: snapshotId, type: "PRE_RESTORE_SNAPSHOT", payload: { not: null } },
        select: { id: true, payload: true },
      })
    );
    if (!snap?.payload) return new Response("Instantané introuvable ou expiré.", { status: 404 });
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "backup.downloaded",
      entityType: "BackupRun",
      entityId: snap.id,
      metadata: { kind: "safety_snapshot" },
    });
    const buf = Buffer.from(snap.payload);
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: fileHeaders(`ASODITECH_SAFETY_${tenant.slug}_${snap.id}${BACKUP_FILE_EXTENSION}`, buf.length),
    });
  }

  const latest = await getDownloadableBackup({ tenantId: user.tenantId, slug: tenant.slug });
  if (!latest) {
    return new Response("Aucune sauvegarde disponible. Générez-en une d'abord.", { status: 404 });
  }
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "backup.downloaded",
    entityType: "BackupRun",
    entityId: latest.runId,
    metadata: { kind: "manual_export" },
  });
  return new Response(new Uint8Array(latest.container), {
    status: 200,
    headers: fileHeaders(latest.filename, latest.container.length),
  });
}
