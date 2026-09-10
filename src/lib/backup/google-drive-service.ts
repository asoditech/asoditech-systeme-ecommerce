import "server-only";

import { prisma } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { recordAuditEvent } from "@/lib/audit";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { generateRawToken, hashToken } from "@/lib/auth/tokens";
import { buildTenantBackup } from "./export";
import { inspectBackup, type InspectedBackup } from "./import";
import { storeRestoreUpload } from "./service";
import {
  isGoogleDriveConfigured,
  buildAuthUrl,
  generatePkcePair,
  exchangeCodeForTokens,
  refreshAccessToken,
  revokeToken,
  fetchAccountEmail,
  ensureBackupFolder,
  listFolderBackups,
  getFileMeta,
  uploadBackup,
  downloadFileBytes,
  deleteFile,
  md5Hex,
  GoogleDriveAuthError,
  GoogleDriveConfigError,
  GoogleDriveApiError,
  type TokenBundle,
  type DriveFile,
} from "./google-drive";

/**
 * DB-facing orchestration for Backup Phase 2 — Google Drive
 * (docs/adr/0034 §"Phase 2"). Every function runs inside a `runWithTenant`
 * directive so the tenant extension + RLS scope every read/write, and
 * every Drive file id is re-verified against THIS tenant's own folder
 * before it is read, written or deleted. Tokens are AES-256-GCM-encrypted
 * at rest and never returned, logged, backed up, or put in an audit
 * payload.
 */

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export { isGoogleDriveConfigured, GoogleDriveAuthError, GoogleDriveConfigError, GoogleDriveApiError } from "./google-drive";

// --- connection read -----------------------------------------------------

export interface DriveConnectionView {
  configured: boolean;
  connected: boolean;
  status: "DECONNECTE" | "CONFIGURE" | "CONNECTE" | "ERREUR";
  accountEmail: string | null;
  lastBackupAt: string | null;
  lastError: string | null;
}

export async function getDriveConnectionView(tenantId: string): Promise<DriveConnectionView> {
  const configured = isGoogleDriveConfigured();
  const conn = configured
    ? await runWithTenant(tenantId, "backup:drive", () =>
        prisma.googleDriveConnection.findUnique({
          where: { tenantId },
          select: { status: true, googleAccountEmail: true, lastBackupAt: true, lastError: true },
        })
      )
    : null;
  return {
    configured,
    connected: conn?.status === "CONNECTE",
    status: conn?.status ?? "DECONNECTE",
    accountEmail: conn?.googleAccountEmail ?? null,
    lastBackupAt: conn?.lastBackupAt?.toISOString() ?? null,
    lastError: conn?.status === "ERREUR" ? conn.lastError ?? null : null,
  };
}

// --- OAuth handshake ----------------------------------------------------

export async function startGoogleOAuth(params: {
  tenantId: string;
  userId: string;
  redirectPath?: string;
}): Promise<{ authUrl: string }> {
  if (!isGoogleDriveConfigured()) throw new GoogleDriveConfigError();
  return runWithTenant(params.tenantId, "backup:drive", async () => {
    // Only ever one live handshake per user.
    await prisma.googleOAuthState.deleteMany({ where: { userId: params.userId } });
    const rawState = generateRawToken();
    const { verifier, challenge } = generatePkcePair();
    await prisma.googleOAuthState.create({
      data: {
        userId: params.userId,
        stateHash: hashToken(rawState),
        codeVerifier: verifier,
        redirectPath: params.redirectPath ?? "/parametres/sauvegarde",
        expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
      },
    });
    return { authUrl: buildAuthUrl({ state: rawState, codeChallenge: challenge }) };
  });
}

export class OAuthStateError extends Error {
  constructor(message = "Requête d'autorisation Google invalide ou expirée. Relancez la connexion.") {
    super(message);
    this.name = "OAuthStateError";
  }
}

export async function completeGoogleOAuth(params: {
  tenantId: string;
  userId: string;
  code: string;
  rawState: string;
}): Promise<{ accountEmail: string | null }> {
  if (!isGoogleDriveConfigured()) throw new GoogleDriveConfigError();

  return runWithTenant(params.tenantId, "backup:drive", async () => {
    const stateHash = hashToken(params.rawState);
    // RLS already scopes this to `tenantId`; also require the user match.
    const stateRow = await prisma.googleOAuthState.findUnique({ where: { stateHash } });
    // Single-use: consume it regardless of what happens next.
    if (stateRow) await prisma.googleOAuthState.deleteMany({ where: { id: stateRow.id } });

    if (
      !stateRow ||
      stateRow.userId !== params.userId ||
      stateRow.tenantId !== params.tenantId ||
      stateRow.expiresAt.getTime() < Date.now()
    ) {
      throw new OAuthStateError();
    }

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: params.tenantId }, select: { slug: true } });

    const tokens = await exchangeCodeForTokens({ code: params.code, codeVerifier: stateRow.codeVerifier });
    const email = await fetchAccountEmail(tokens.accessToken);
    const folder = await ensureBackupFolder({
      accessToken: tokens.accessToken,
      tenantId: params.tenantId,
      tenantSlug: tenant.slug,
    });

    await prisma.googleDriveConnection.upsert({
      where: { tenantId: params.tenantId },
      update: {
        status: "CONNECTE",
        credentialsEncrypted: encryptSecret(JSON.stringify(tokens)),
        googleAccountEmail: email,
        driveFolderId: folder.id,
        driveFolderName: folder.path,
        lastConnectionCheckAt: new Date(),
        lastError: null,
        connectedById: params.userId,
      },
      create: {
        status: "CONNECTE",
        credentialsEncrypted: encryptSecret(JSON.stringify(tokens)),
        googleAccountEmail: email,
        driveFolderId: folder.id,
        driveFolderName: folder.path,
        lastConnectionCheckAt: new Date(),
        connectedById: params.userId,
      },
    });

    await recordAuditEvent({
      actorType: "USER",
      actorUserId: params.userId,
      action: "backup.drive_connected",
      entityType: "GoogleDriveConnection",
      entityId: params.tenantId,
      metadata: { accountEmail: email ?? "(inconnu)" },
    });

    return { accountEmail: email };
  });
}

export async function disconnectGoogleDrive(params: { tenantId: string; userId: string }): Promise<void> {
  await runWithTenant(params.tenantId, "backup:drive", async () => {
    const conn = await prisma.googleDriveConnection.findUnique({ where: { tenantId: params.tenantId } });
    if (!conn) return;
    // Best-effort token revocation — never blocks the disconnect.
    try {
      const bundle = JSON.parse(decryptSecret(conn.credentialsEncrypted)) as TokenBundle;
      await revokeToken(bundle.refreshToken);
    } catch {
      /* ignore */
    }
    await prisma.googleDriveConnection.delete({ where: { tenantId: params.tenantId } });
    await prisma.googleOAuthState.deleteMany({ where: {} });
    // DRIVE_EXPORT BackupRun rows are kept — they document what is on Drive
    // and local tenant data is never touched by a disconnect.

    await recordAuditEvent({
      actorType: "USER",
      actorUserId: params.userId,
      action: "backup.drive_disconnected",
      entityType: "GoogleDriveConnection",
      entityId: params.tenantId,
    });
  });
}

// --- token lifecycle for Drive calls -----------------------------------

/** Loads the connection, refreshes the access token if it is within a
 * minute of expiry, persists the refreshed bundle, and runs `fn`. On an
 * auth failure the connection is marked ERREUR and a friendly
 * `GoogleDriveAuthError` is thrown so the UI can prompt a reconnect. */
async function withValidAccessToken<T>(
  tenantId: string,
  userId: string | null,
  fn: (accessToken: string, folderId: string, tenantSlug: string) => Promise<T>
): Promise<T> {
  return runWithTenant(tenantId, "backup:drive", async () => {
    const conn = await prisma.googleDriveConnection.findUnique({ where: { tenantId } });
    if (!conn || conn.status === "DECONNECTE") {
      throw new GoogleDriveAuthError("Google Drive n'est pas connecté pour ce compte.");
    }
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true } });

    let bundle: TokenBundle;
    try {
      bundle = JSON.parse(decryptSecret(conn.credentialsEncrypted)) as TokenBundle;
    } catch {
      await markConnectionError(tenantId, userId, "Jeton illisible.");
      throw new GoogleDriveAuthError();
    }

    try {
      if (new Date(bundle.accessTokenExpiresAt).getTime() <= Date.now()) {
        const refreshed = await refreshAccessToken(bundle.refreshToken);
        bundle = { ...bundle, ...refreshed };
        await prisma.googleDriveConnection.update({
          where: { tenantId },
          data: { credentialsEncrypted: encryptSecret(JSON.stringify(bundle)), lastConnectionCheckAt: new Date() },
        });
      }

      // Always (re)resolve the folder — `ensureBackupFolder` is idempotent
      // and re-creates it if it was deleted in Drive (§failure behaviour).
      const folder = await ensureBackupFolder({
        accessToken: bundle.accessToken,
        tenantId,
        tenantSlug: tenant.slug,
      });
      if (folder.id !== conn.driveFolderId || folder.path !== conn.driveFolderName) {
        await prisma.googleDriveConnection.update({
          where: { tenantId },
          data: { driveFolderId: folder.id, driveFolderName: folder.path },
        });
      }

      return await fn(bundle.accessToken, folder.id, tenant.slug);
    } catch (err) {
      if (err instanceof GoogleDriveAuthError) {
        await markConnectionError(tenantId, userId, err.message);
      }
      throw err;
    }
  });
}

async function markConnectionError(tenantId: string, userId: string | null, message: string): Promise<void> {
  await prisma.googleDriveConnection.updateMany({
    where: { tenantId },
    data: { status: "ERREUR", lastError: message.slice(0, 300) },
  });
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: userId,
    action: "backup.drive_token_error",
    entityType: "GoogleDriveConnection",
    entityId: tenantId,
    metadata: { reason: message.slice(0, 200) },
  });
}

// --- backup to Drive --------------------------------------------------

export interface DriveBackupItem {
  /** The tenant-scoped BackupRun id — this, not the raw Drive file id, is
   * what the UI/actions pass back for download/restore/delete. */
  recordId: string;
  fileId: string;
  name: string;
  sizeBytes: number;
  createdAt: string;
  totalRows: number | null;
  checksumSha256: string | null;
  /** false ⇒ the Drive file is gone (deleted outside ASODITECH). */
  existsOnDrive: boolean;
}

export async function pushBackupToDrive(params: {
  tenantId: string;
  userId: string;
  slug: string;
}): Promise<{ fileId: string; name: string; sizeBytes: number; totalRows: number }> {
  const backup = await buildTenantBackup({ tenantId: params.tenantId, createdByUserId: params.userId });

  // Verify the freshly-built package BEFORE upload (checksum + structure).
  const check = inspectBackup(backup.container);
  if (!check.valid) {
    throw new GoogleDriveApiError(`La sauvegarde générée est invalide, envoi annulé : ${check.errors.join(" ; ")}`);
  }
  const localMd5 = md5Hex(backup.container);
  const filename = driveFilename(params.slug);

  return withValidAccessToken(params.tenantId, params.userId, async (accessToken, folderId) => {
    const uploaded = await uploadBackup({ accessToken, folderId, filename, bytes: backup.container });

    // Verify the upload landed correctly: right size, right bytes, right folder.
    if (uploaded.sizeBytes !== backup.container.length) {
      await deleteFile({ accessToken, fileId: uploaded.id }).catch(() => {});
      throw new GoogleDriveApiError("Taille du fichier envoyé incohérente — envoi annulé.");
    }
    if (uploaded.md5Checksum && uploaded.md5Checksum !== localMd5) {
      await deleteFile({ accessToken, fileId: uploaded.id }).catch(() => {});
      throw new GoogleDriveApiError("Empreinte du fichier envoyé incohérente — envoi annulé.");
    }
    const meta = await getFileMeta({ accessToken, fileId: uploaded.id });
    if (!meta.parents.includes(folderId)) {
      await deleteFile({ accessToken, fileId: uploaded.id }).catch(() => {});
      throw new GoogleDriveApiError("Le fichier envoyé n'est pas dans le dossier attendu — envoi annulé.");
    }

    await prisma.backupRun.create({
      data: {
        type: "DRIVE_EXPORT",
        status: "READY",
        formatVersion: backup.manifest.version,
        appVersion: backup.manifest.appVersion,
        schemaVersion: backup.manifest.schemaVersion,
        counts: backup.counts as object,
        sizeBytes: backup.sizeBytes,
        checksumSha256: backup.manifest.checksum.data,
        payload: null,
        driveFileId: uploaded.id,
        driveFileName: uploaded.name,
        driveUploadedAt: new Date(),
        createdById: params.userId,
      },
    });
    await prisma.googleDriveConnection.update({
      where: { tenantId: params.tenantId },
      data: { lastBackupAt: new Date(), status: "CONNECTE", lastError: null },
    });

    await recordAuditEvent({
      actorType: "USER",
      actorUserId: params.userId,
      action: "backup.drive_uploaded",
      entityType: "BackupRun",
      entityId: uploaded.id,
      metadata: { sizeBytes: backup.sizeBytes, totalRows: backup.manifest.totalRows },
    });

    return { fileId: uploaded.id, name: uploaded.name, sizeBytes: backup.sizeBytes, totalRows: backup.manifest.totalRows };
  });
}

/**
 * The tenant's Drive backups — driven by the tenant-scoped `BackupRun`
 * records (RLS), then reconciled against a single Drive folder listing so
 * the UI can show which files still physically exist.
 */
export async function listDriveBackups(tenantId: string): Promise<DriveBackupItem[]> {
  return withValidAccessToken(tenantId, null, async (accessToken, folderId) => {
    const records = await prisma.backupRun.findMany({
      where: { type: "DRIVE_EXPORT", status: { not: "EXPIRED" }, driveFileId: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { id: true, driveFileId: true, driveFileName: true, sizeBytes: true, createdAt: true, counts: true, checksumSha256: true },
    });
    if (records.length === 0) return [];
    const onDrive = new Map((await listFolderBackups({ accessToken, folderId })).map((f) => [f.id, f]));
    return records.map((r) => {
      const counts = (r.counts ?? null) as Record<string, number> | null;
      const live = onDrive.get(r.driveFileId!);
      return {
        recordId: r.id,
        fileId: r.driveFileId!,
        name: live?.name ?? r.driveFileName ?? "sauvegarde.asb",
        sizeBytes: live?.sizeBytes ?? r.sizeBytes,
        createdAt: r.createdAt.toISOString(),
        totalRows: counts ? Object.values(counts).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0) : null,
        checksumSha256: r.checksumSha256 || null,
        existsOnDrive: Boolean(live),
      };
    });
  });
}

/**
 * Resolve a client-supplied reference (a BackupRun id OR a Drive file id)
 * to a `BackupRun` row that BELONGS TO THE ACTIVE TENANT. RLS + this
 * lookup are the authoritative check (§9) — an arbitrary Drive file id
 * with no tenant record is rejected here, before any Drive call.
 */
async function resolveDriveRecord(
  ref: string
): Promise<{ id: string; driveFileId: string; driveFileName: string | null }> {
  const row = await prisma.backupRun.findFirst({
    where: {
      type: "DRIVE_EXPORT",
      OR: [{ id: ref }, { driveFileId: ref }],
    },
    select: { id: true, driveFileId: true, driveFileName: true },
  });
  if (!row?.driveFileId) {
    throw new GoogleDriveApiError("Sauvegarde Google Drive introuvable pour ce compte.");
  }
  return { id: row.id, driveFileId: row.driveFileId, driveFileName: row.driveFileName };
}

/** Second layer, after `resolveDriveRecord`: the file must physically sit
 * in THIS tenant's Drive folder (guards the "same Google account, two
 * tenants" case and a stale record). */
async function assertFileInFolder(accessToken: string, folderId: string, fileId: string): Promise<DriveFile> {
  const meta = await getFileMeta({ accessToken, fileId });
  if (!meta.parents.includes(folderId)) {
    throw new GoogleDriveApiError("Ce fichier n'appartient pas au dossier de sauvegarde de ce compte.");
  }
  return meta;
}

export async function downloadDriveBackup(params: {
  tenantId: string;
  userId: string;
  /** BackupRun id or Drive file id — resolved to a tenant record first. */
  ref: string;
}): Promise<{ bytes: Buffer; filename: string }> {
  return withValidAccessToken(params.tenantId, params.userId, async (accessToken, folderId) => {
    const rec = await resolveDriveRecord(params.ref);
    const meta = await assertFileInFolder(accessToken, folderId, rec.driveFileId);
    const bytes = await downloadFileBytes({ accessToken, fileId: rec.driveFileId, declaredSize: meta.sizeBytes });
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: params.userId,
      action: "backup.drive_downloaded",
      entityType: "BackupRun",
      entityId: rec.id,
      metadata: { sizeBytes: bytes.length },
    });
    return { bytes, filename: meta.name || rec.driveFileName || driveFilename(params.tenantId) };
  });
}

export async function deleteDriveBackup(params: { tenantId: string; userId: string; ref: string }): Promise<void> {
  return withValidAccessToken(params.tenantId, params.userId, async (accessToken, folderId) => {
    const rec = await resolveDriveRecord(params.ref);
    // A file already gone from Drive is fine — still expire the record.
    try {
      await assertFileInFolder(accessToken, folderId, rec.driveFileId);
      await deleteFile({ accessToken, fileId: rec.driveFileId });
    } catch (err) {
      if (!(err instanceof GoogleDriveApiError)) throw err;
    }
    await prisma.backupRun.update({ where: { id: rec.id }, data: { status: "EXPIRED" } });
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: params.userId,
      action: "backup.drive_deleted",
      entityType: "BackupRun",
      entityId: rec.id,
    });
  });
}

/** Download a Drive backup and hand it to the EXISTING Phase-1 restore
 * pipeline (`storeRestoreUpload` → preview → `confirmRestoreAction`). No
 * restore logic is duplicated or bypassed. */
export async function prepareRestoreFromDrive(params: {
  tenantId: string;
  userId: string;
  ref: string;
}): Promise<{ uploadId: string; inspected: InspectedBackup }> {
  const { bytes } = await downloadDriveBackup({ tenantId: params.tenantId, userId: params.userId, ref: params.ref });
  return storeRestoreUpload({ tenantId: params.tenantId, userId: params.userId, container: bytes });
}

function driveFilename(slug: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safe = slug.replace(/[^a-z0-9-]+/gi, "-").toLowerCase() || "tenant";
  return `ASODITECH_BACKUP_${safe}_${stamp}.asb`;
}
