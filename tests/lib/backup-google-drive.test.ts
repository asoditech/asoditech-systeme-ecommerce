import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import {
  startGoogleOAuth,
  completeGoogleOAuth,
  disconnectGoogleDrive,
  pushBackupToDrive,
  listDriveBackups,
  downloadDriveBackup,
  deleteDriveBackup,
  prepareRestoreFromDrive,
  getDriveConnectionView,
  GoogleDriveAuthError,
} from "@/lib/backup/google-drive-service";
import { runRestore, createManualBackup, storeRestoreUpload } from "@/lib/backup/service";
import { openBackup } from "@/lib/backup/container";
import { encryptSecret } from "@/lib/crypto";
import {
  pushBackupToDriveAction,
  deleteDriveBackupAction,
  restoreFromDriveAction,
  disconnectGoogleDriveAction,
  startGoogleDriveConnectAction,
} from "@/actions/backup-google-drive";
import { makeFakeDrive, installFakeGoogle, type FakeDriveState } from "../helpers/fake-google-drive";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";
import { createTestUser, loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

const TENANT_A = DEFAULT_TENANT_ID;
const TENANT_B = "tenant-b-gdrive";

async function seedTenant(tenantId: string, tag: string) {
  await prismaBase.tenant.upsert({
    where: { id: tenantId },
    update: {},
    create: { id: tenantId, name: `Tenant ${tag}`, slug: tenantId },
  });
  await prismaBase.businessSettings.upsert({ where: { tenantId }, update: {}, create: { tenantId, companyName: `Co ${tag}` } });
  const customer = await prismaBase.customer.create({ data: { tenantId, fullName: `Client ${tag}` } });
  await prismaBase.order.create({
    data: { tenantId, customerId: customer.id, subtotal: "10", total: "10", currency: "MAD" },
  });
  await prismaBase.product.create({ data: { tenantId, name: `P ${tag}`, sku: `SKU-${tenantId}`, price: "10" } });
}

/** Complete the OAuth handshake for `tenantId` against `drive`. */
async function connect(tenantId: string, userId: string, drive: FakeDriveState) {
  const { authUrl } = await startGoogleOAuth({ tenantId, userId });
  const state = new URL(authUrl).searchParams.get("state")!;
  return completeGoogleOAuth({
    tenantId,
    userId,
    code: `code-for-${drive.accountEmail}`,
    rawState: state,
  });
}

let userA: { id: string };
let userB: { id: string };
let driveA: FakeDriveState;
let driveB: FakeDriveState;

describe("Backup Phase 2 — Google Drive", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-client-id");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-client-secret");
    driveA = makeFakeDrive("a@drive.test");
    driveB = makeFakeDrive("b@drive.test");
    installFakeGoogle([driveA, driveB]);
    await seedTenant(TENANT_A, "A");
    await seedTenant(TENANT_B, "B");
    userA = await createTestUser({ tenantId: TENANT_A, role: "OWNER", email: "owner.a@gd.test" });
    userB = await createTestUser({ tenantId: TENANT_B, role: "OWNER", email: "owner.b@gd.test" });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await resetDb();
    mockCookieStore.clear();
  });

  it("connect → upload → list → download → existing restore pipeline (happy path)", async () => {
    await connect(TENANT_A, userA.id, driveA);
    const view = await getDriveConnectionView(TENANT_A);
    expect(view).toMatchObject({ configured: true, connected: true, status: "CONNECTE", accountEmail: "a@drive.test" });

    const up = await pushBackupToDrive({ tenantId: TENANT_A, userId: userA.id, slug: TENANT_A });
    expect(up.fileId).toBeTruthy();
    expect(up.totalRows).toBeGreaterThan(0);

    const list = await listDriveBackups(TENANT_A);
    expect(list).toHaveLength(1);
    expect(list[0].fileId).toBe(up.fileId);
    expect(list[0].recordId).toBeTruthy();
    expect(list[0].existsOnDrive).toBe(true);

    // download by BackupRun id (what the UI passes) AND by raw fileId both work
    const dl = await downloadDriveBackup({ tenantId: TENANT_A, userId: userA.id, ref: list[0].recordId });
    expect(() => openBackup(dl.bytes)).not.toThrow();
    const dl2 = await downloadDriveBackup({ tenantId: TENANT_A, userId: userA.id, ref: up.fileId });
    expect(dl2.bytes.equals(dl.bytes)).toBe(true);

    // Restore goes through the EXACT Phase-1 pipeline.
    const stored = await prepareRestoreFromDrive({ tenantId: TENANT_A, userId: userA.id, ref: list[0].recordId });
    expect(stored.inspected.valid).toBe(true);
    const outcome = await runRestore({ tenantId: TENANT_A, userId: userA.id, uploadId: stored.uploadId });
    expect(Object.values(outcome.result.restoredCounts).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it("a DRIVE_EXPORT BackupRun row is created; its payload stays NULL (Drive holds the bytes)", async () => {
    await connect(TENANT_A, userA.id, driveA);
    await pushBackupToDrive({ tenantId: TENANT_A, userId: userA.id, slug: TENANT_A });
    const row = await runWithTenant(TENANT_A, "t", () =>
      prisma.backupRun.findFirstOrThrow({ where: { type: "DRIVE_EXPORT" } })
    );
    expect(row.payload).toBeNull();
    expect(row.driveFileId).toBeTruthy();
    expect(row.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("tokens are encrypted at rest and never surface in a connection view or audit payload", async () => {
    await connect(TENANT_A, userA.id, driveA);
    const conn = await runWithTenant(TENANT_A, "t", () =>
      prisma.googleDriveConnection.findUniqueOrThrow({ where: { tenantId: TENANT_A } })
    );
    expect(conn.credentialsEncrypted).not.toContain("refresh-");
    expect(conn.credentialsEncrypted).not.toContain("access-");
    expect(conn.credentialsEncrypted.split(":")).toHaveLength(3); // iv:tag:ciphertext

    const view = await getDriveConnectionView(TENANT_A);
    expect(JSON.stringify(view)).not.toMatch(/refresh-|access-/);

    const audits = await runWithTenant(TENANT_A, "t", () =>
      prisma.auditEvent.findMany({ where: { action: { startsWith: "backup.drive" } } })
    );
    expect(audits.length).toBeGreaterThan(0);
    for (const a of audits) {
      expect(JSON.stringify(a.metadata ?? {})).not.toMatch(/refresh-|access-|test-client-secret/);
    }
  });

  // --- adversarial ------------------------------------------------------

  it("CROSS-TENANT: tenant B (same Google account) cannot download / delete / restore tenant A's Drive file", async () => {
    // Both tenants connect the SAME underlying Google account.
    await connect(TENANT_A, userA.id, driveA);
    await connect(TENANT_B, userB.id, driveA);
    const aUpload = await pushBackupToDrive({ tenantId: TENANT_A, userId: userA.id, slug: TENANT_A });

    // B knows A's raw Drive file id and tries every operation with it — it
    // has no BackupRun record for tenant B, so it's rejected before any
    // Drive call.
    await expect(
      downloadDriveBackup({ tenantId: TENANT_B, userId: userB.id, ref: aUpload.fileId })
    ).rejects.toThrow(/introuvable pour ce compte/i);
    await expect(
      deleteDriveBackup({ tenantId: TENANT_B, userId: userB.id, ref: aUpload.fileId })
    ).rejects.toThrow(/introuvable pour ce compte/i);
    await expect(
      prepareRestoreFromDrive({ tenantId: TENANT_B, userId: userB.id, ref: aUpload.fileId })
    ).rejects.toThrow(/introuvable pour ce compte/i);

    // B's own list never shows A's file.
    const bList = await listDriveBackups(TENANT_B);
    expect(bList.map((f) => f.fileId)).not.toContain(aUpload.fileId);

    // A's file is still there and still A's.
    const aList = await listDriveBackups(TENANT_A);
    expect(aList.map((f) => f.fileId)).toEqual([aUpload.fileId]);
  });

  it("CROSS-TENANT: RLS keeps one tenant's GoogleDriveConnection / OAuth state invisible to another", async () => {
    await connect(TENANT_A, userA.id, driveA);
    await startGoogleOAuth({ tenantId: TENANT_B, userId: userB.id });

    const seenByB = await runWithTenant(TENANT_B, "t", () =>
      prisma.googleDriveConnection.findMany()
    );
    expect(seenByB).toHaveLength(0); // A's connection is invisible

    const statesSeenByA = await runWithTenant(TENANT_A, "t", () => prisma.googleOAuthState.findMany());
    expect(statesSeenByA).toHaveLength(0); // B's pending state is invisible
  });

  it("INVALID / EXPIRED OAuth state is rejected", async () => {
    // unknown state
    await expect(
      completeGoogleOAuth({ tenantId: TENANT_A, userId: userA.id, code: "code-for-a@drive.test", rawState: "bogus-state" })
    ).rejects.toThrow(/invalide ou expir/i);

    // valid state but wrong user
    const { authUrl } = await startGoogleOAuth({ tenantId: TENANT_A, userId: userA.id });
    const state = new URL(authUrl).searchParams.get("state")!;
    await expect(
      completeGoogleOAuth({ tenantId: TENANT_A, userId: userB.id, code: "code-for-a@drive.test", rawState: state })
    ).rejects.toThrow(/invalide ou expir/i);
    // and it was consumed — a retry with the right user now also fails
    await expect(
      completeGoogleOAuth({ tenantId: TENANT_A, userId: userA.id, code: "code-for-a@drive.test", rawState: state })
    ).rejects.toThrow(/invalide ou expir/i);

    // expired state
    const { authUrl: url2 } = await startGoogleOAuth({ tenantId: TENANT_A, userId: userA.id });
    const state2 = new URL(url2).searchParams.get("state")!;
    await runWithTenant(TENANT_A, "t", () =>
      prisma.googleOAuthState.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } })
    );
    await expect(
      completeGoogleOAuth({ tenantId: TENANT_A, userId: userA.id, code: "code-for-a@drive.test", rawState: state2 })
    ).rejects.toThrow(/invalide ou expir/i);
  });

  it("REVOKED Google token: the connection is marked ERREUR and the UI is told to reconnect", async () => {
    await connect(TENANT_A, userA.id, driveA);
    await pushBackupToDrive({ tenantId: TENANT_A, userId: userA.id, slug: TENANT_A });

    driveA.revokeRefreshToken = true;
    // force a refresh by expiring the stored access token
    const staleBundle = encryptSecret(
      JSON.stringify({
        refreshToken: driveA.refreshToken,
        accessToken: "access-a@drive.test-x",
        accessTokenExpiresAt: new Date(0).toISOString(),
        scope: "",
      })
    );
    await runWithTenant(TENANT_A, "t", () =>
      prisma.googleDriveConnection.update({
        where: { tenantId: TENANT_A },
        data: { credentialsEncrypted: staleBundle },
      })
    );

    await expect(pushBackupToDrive({ tenantId: TENANT_A, userId: userA.id, slug: TENANT_A })).rejects.toBeInstanceOf(
      GoogleDriveAuthError
    );
    const view = await getDriveConnectionView(TENANT_A);
    expect(view.status).toBe("ERREUR");
    expect(view.connected).toBe(false);
    const audit = await runWithTenant(TENANT_A, "t", () =>
      prisma.auditEvent.findFirst({ where: { action: "backup.drive_token_error" } })
    );
    expect(audit).not.toBeNull();
  });

  it("UPLOAD FAILURE: nothing is recorded and the error is surfaced", async () => {
    await connect(TENANT_A, userA.id, driveA);
    driveA.failUpload = true;
    await expect(pushBackupToDrive({ tenantId: TENANT_A, userId: userA.id, slug: TENANT_A })).rejects.toThrow();
    const rows = await runWithTenant(TENANT_A, "t", () =>
      prisma.backupRun.count({ where: { type: "DRIVE_EXPORT" } })
    );
    expect(rows).toBe(0);
  });

  it("CHECKSUM MISMATCH on upload: the uploaded file is deleted and no record is kept", async () => {
    await connect(TENANT_A, userA.id, driveA);
    driveA.mismatchMd5 = true;
    await expect(pushBackupToDrive({ tenantId: TENANT_A, userId: userA.id, slug: TENANT_A })).rejects.toThrow(/empreinte/i);
    expect([...driveA.files.values()].filter((f) => f.mimeType === "application/octet-stream")).toHaveLength(0);
    const rows = await runWithTenant(TENANT_A, "t", () => prisma.backupRun.count({ where: { type: "DRIVE_EXPORT" } }));
    expect(rows).toBe(0);
  });

  it("DOWNLOAD FAILURE from Drive is surfaced, restore pipeline never entered", async () => {
    await connect(TENANT_A, userA.id, driveA);
    const up = await pushBackupToDrive({ tenantId: TENANT_A, userId: userA.id, slug: TENANT_A });
    driveA.failDownload = true;
    await expect(downloadDriveBackup({ tenantId: TENANT_A, userId: userA.id, ref: up.fileId })).rejects.toThrow();
    await expect(prepareRestoreFromDrive({ tenantId: TENANT_A, userId: userA.id, ref: up.fileId })).rejects.toThrow();
  });

  it("CORRUPTED .asb downloaded from Drive is rejected by the existing checksum/decryption pipeline", async () => {
    await connect(TENANT_A, userA.id, driveA);
    const up = await pushBackupToDrive({ tenantId: TENANT_A, userId: userA.id, slug: TENANT_A });
    driveA.corruptDownloadFileId = up.fileId;

    // downloadDriveBackup returns the bytes (magic still ASB1); the Phase-1
    // inspect step is what rejects it.
    await expect(prepareRestoreFromDrive({ tenantId: TENANT_A, userId: userA.id, ref: up.fileId })).rejects.toThrow();
  });

  it("an arbitrary Drive fileId with NO tenant BackupRun record is rejected before any Drive call", async () => {
    await connect(TENANT_A, userA.id, driveA);
    const conn = await runWithTenant(TENANT_A, "t", () =>
      prisma.googleDriveConnection.findUniqueOrThrow({ where: { tenantId: TENANT_A } })
    );
    // a real file sitting in A's own folder, but never recorded by ASODITECH
    const strayId = "file-a@drive.test-stray";
    driveA.files.set(strayId, {
      id: strayId,
      name: "manually-placed.asb",
      mimeType: "application/octet-stream",
      parents: [conn.driveFolderId!],
      appProperties: {},
      createdTime: new Date().toISOString(),
      bytes: Buffer.from("ASB1 and then some junk that is not a backup"),
    });
    await expect(
      downloadDriveBackup({ tenantId: TENANT_A, userId: userA.id, ref: strayId })
    ).rejects.toThrow(/introuvable pour ce compte/i);
    await expect(
      prepareRestoreFromDrive({ tenantId: TENANT_A, userId: userA.id, ref: strayId })
    ).rejects.toThrow(/introuvable pour ce compte/i);
  });

  it("a recorded backup whose Drive bytes are NOT a valid .asb is rejected on the magic-bytes check", async () => {
    await connect(TENANT_A, userA.id, driveA);
    const conn = await runWithTenant(TENANT_A, "t", () =>
      prisma.googleDriveConnection.findUniqueOrThrow({ where: { tenantId: TENANT_A } })
    );
    const junkId = "file-a@drive.test-junk";
    driveA.files.set(junkId, {
      id: junkId,
      name: "corrupt.asb",
      mimeType: "application/octet-stream",
      parents: [conn.driveFolderId!],
      appProperties: {},
      createdTime: new Date().toISOString(),
      bytes: Buffer.from("just some text, definitely not an ASODITECH backup"),
    });
    // A record exists (so resolveDriveRecord passes) but the file content is junk.
    const rec = await runWithTenant(TENANT_A, "t", () =>
      prisma.backupRun.create({
        data: {
          type: "DRIVE_EXPORT",
          status: "READY",
          formatVersion: 1,
          appVersion: "0.0.0",
          schemaVersion: "test",
          counts: {},
          driveFileId: junkId,
          driveFileName: "corrupt.asb",
        },
        select: { id: true },
      })
    );
    await expect(downloadDriveBackup({ tenantId: TENANT_A, userId: userA.id, ref: rec.id })).rejects.toThrow(/\.asb/i);
  });

  it("DISCONNECT keeps local data + DRIVE_EXPORT records, only removes the connection", async () => {
    await connect(TENANT_A, userA.id, driveA);
    await pushBackupToDrive({ tenantId: TENANT_A, userId: userA.id, slug: TENANT_A });

    const ordersBefore = await prismaBase.order.count({ where: { tenantId: TENANT_A } });
    await disconnectGoogleDrive({ tenantId: TENANT_A, userId: userA.id });

    expect(await getDriveConnectionView(TENANT_A)).toMatchObject({ connected: false, status: "DECONNECTE" });
    expect(await prismaBase.order.count({ where: { tenantId: TENANT_A } })).toBe(ordersBefore);
    expect(await prismaBase.backupRun.count({ where: { tenantId: TENANT_A, type: "DRIVE_EXPORT" } })).toBe(1);
    // Tenant B, if it were connected, is untouched.
  });

  it("DISCONNECT isolation: disconnecting A does not touch B's connection", async () => {
    await connect(TENANT_A, userA.id, driveA);
    await connect(TENANT_B, userB.id, driveB);
    await disconnectGoogleDrive({ tenantId: TENANT_A, userId: userA.id });
    expect((await getDriveConnectionView(TENANT_A)).connected).toBe(false);
    expect((await getDriveConnectionView(TENANT_B)).connected).toBe(true);
  });

  it("local manual backup + restore keep working while Google Drive is disconnected", async () => {
    // No Drive connection at all.
    expect((await getDriveConnectionView(TENANT_A)).connected).toBe(false);

    const local = await createManualBackup({ tenantId: TENANT_A, userId: userA.id, slug: "acme" });
    expect(local.container.length).toBeGreaterThan(0);
    expect(() => openBackup(local.container)).not.toThrow();

    const stored = await storeRestoreUpload({ tenantId: TENANT_A, userId: userA.id, container: local.container });
    expect(stored.inspected.valid).toBe(true);
    const outcome = await runRestore({ tenantId: TENANT_A, userId: userA.id, uploadId: stored.uploadId });
    expect(Object.values(outcome.result.restoredCounts).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it("a FAILED Drive operation is audited (backup.drive_operation_failed), success and failure both", async () => {
    await loginAsTestUser({ tenantId: TENANT_A, role: "OWNER", email: "owner.fail@gd.test" });
    const acting = await prismaBase.user.findFirstOrThrow({ where: { email: "owner.fail@gd.test" } });
    await connect(TENANT_A, acting.id, driveA);

    driveA.failUpload = true;
    const res = await pushBackupToDriveAction();
    expect(res.ok).toBe(false);

    const failAudit = await runWithTenant(TENANT_A, "t", () =>
      prisma.auditEvent.findFirst({ where: { action: "backup.drive_operation_failed" } })
    );
    expect(failAudit).not.toBeNull();
    expect((failAudit!.metadata as { operation?: string }).operation).toBe("upload");
    expect(JSON.stringify(failAudit!.metadata)).not.toMatch(/refresh-|access-/);

    // and a SUCCESS is still audited on the happy path
    driveA.failUpload = false;
    const ok = await pushBackupToDriveAction();
    expect(ok.ok).toBe(true);
    const okAudit = await runWithTenant(TENANT_A, "t", () =>
      prisma.auditEvent.findFirst({ where: { action: "backup.drive_uploaded" } })
    );
    expect(okAudit).not.toBeNull();
  });

  // --- RBAC via the Server Actions -----------------------------------

  it("RBAC: a WAREHOUSE user (no settings.manage) is rejected by every Drive action", async () => {
    await loginAsTestUser({ tenantId: TENANT_A, role: "WAREHOUSE" });
    await expect(startGoogleDriveConnectAction()).rejects.toThrow(/permission/i);
    await expect(pushBackupToDriveAction()).rejects.toThrow(/permission/i);
    await expect(disconnectGoogleDriveAction()).rejects.toThrow(/permission/i);
    const fd = new FormData();
    fd.set("fileId", "x");
    await expect(deleteDriveBackupAction(fd)).rejects.toThrow(/permission/i);
    await expect(restoreFromDriveAction(fd)).rejects.toThrow(/permission/i);
  });

  it("RBAC: an OWNER can, and the push action returns only safe metadata", async () => {
    await loginAsTestUser({ tenantId: TENANT_A, role: "OWNER", email: "owner.rbac@gd.test" });
    // connect first via the service (the action just builds the auth URL)
    const start = await startGoogleDriveConnectAction();
    expect(start.ok).toBe(true);
    if (start.ok) expect(start.data.authUrl).toContain("accounts.google.com");

    const acting = await prismaBase.user.findFirstOrThrow({ where: { email: "owner.rbac@gd.test" } });
    await connect(TENANT_A, acting.id, driveA);

    const res = await pushBackupToDriveAction();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toHaveProperty("totalRows");
      expect(JSON.stringify(res.data)).not.toMatch(/refresh-|access-/);
    }
  });

  it("when Google OAuth is NOT configured, every Drive path is inert", async () => {
    vi.unstubAllEnvs(); // clear the client id/secret
    const view = await getDriveConnectionView(TENANT_A);
    expect(view).toMatchObject({ configured: false, connected: false });
    await loginAsTestUser({ tenantId: TENANT_A, role: "OWNER", email: "owner.unconf@gd.test" });
    const res = await startGoogleDriveConnectAction();
    expect(res.ok).toBe(false);
  });
});
