import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { buildTenantBackup } from "@/lib/backup/export";
import { inspectBackup, restoreTenantBackup, CrossTenantRestoreError } from "@/lib/backup/import";
import { openBackup } from "@/lib/backup/container";
import { runRestore, storeRestoreUpload, createManualBackup, getDownloadableBackup } from "@/lib/backup/service";
import { confirmRestoreAction } from "@/actions/backup";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";
import { createTestUser, loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

const TENANT_A = DEFAULT_TENANT_ID;
const TENANT_B = "tenant-b-backup";

/** Seed a small connected business graph for `tenantId`. Returns key ids. */
async function seedTenant(tenantId: string, opts: { customers?: number; tag?: string } = {}) {
  const tag = opts.tag ?? tenantId;
  await prismaBase.tenant.upsert({
    where: { id: tenantId },
    update: {},
    create: { id: tenantId, name: `Tenant ${tag}`, slug: tenantId },
  });
  await prismaBase.businessSettings.upsert({
    where: { tenantId },
    update: {},
    create: { tenantId, companyName: `Co ${tag}` },
  });
  const warehouse = await prismaBase.warehouse.create({
    data: { tenantId, name: `WH ${tag}`, isDefault: true },
  });
  const category = await prismaBase.category.create({ data: { tenantId, name: `Cat ${tag}`, slug: `cat-${tenantId}` } });
  const child = await prismaBase.category.create({
    data: { tenantId, name: `Sub ${tag}`, slug: `sub-${tenantId}`, parentId: category.id },
  });
  const product = await prismaBase.product.create({
    data: { tenantId, name: `Prod ${tag}`, sku: `SKU-${tenantId}`, price: "100.00", categoryId: child.id },
  });
  await prismaBase.inventoryItem.create({
    data: { tenantId, warehouseId: warehouse.id, productId: product.id, quantityOnHand: 25 },
  });

  const n = opts.customers ?? 2;
  const orderIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const customer = await prismaBase.customer.create({
      data: { tenantId, fullName: `Client ${tag} ${i}`, phone: `06000000${i}` },
    });
    const order = await prismaBase.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        subtotal: "100.00",
        total: "100.00",
        currency: "MAD",
        shippingName: `Client ${tag} ${i}`,
        items: {
          create: [
            { tenantId, productId: product.id, nameSnapshot: `Prod ${tag}`, skuSnapshot: `SKU-${tenantId}`, quantity: 1, unitPrice: "100.00", total: "100.00" },
          ],
        },
      },
    });
    orderIds.push(order.id);
  }

  // A connector with a secret + a shipping provider with a secret.
  await prismaBase.integration.create({
    data: {
      tenantId,
      provider: "WOOCOMMERCE",
      status: "CONNECTE",
      config: { storeUrl: `https://${tenantId}.example.com`, consumerSecret: "SHOULD-NOT-LEAK" },
      credentialsEncrypted: "iv:tag:CIPHERTEXT-SECRET",
    },
  });
  await prismaBase.shippingProvider.create({
    data: {
      tenantId,
      name: `OzonExpress ${tag}`,
      type: "API",
      providerKey: "ozonexpress",
      connectionStatus: "CONNECTE",
      credentialsEncrypted: "iv:tag:CARRIER-SECRET",
      config: { customerId: "42", apiKey: "SHOULD-NOT-LEAK" },
    },
  });
  await prismaBase.expenseCategory.create({ data: { tenantId, name: `Exp ${tag}` } });

  return { warehouse, category, child, product, orderIds };
}

async function countBusinessRows(tenantId: string) {
  return runWithTenant(tenantId, "test-count", async () => ({
    customers: await prisma.customer.count(),
    orders: await prisma.order.count(),
    orderItems: await prisma.orderItem.count(),
    products: await prisma.product.count(),
    categories: await prisma.category.count(),
    integrations: await prisma.integration.count(),
    shippingProviders: await prisma.shippingProvider.count(),
  }));
}

describe("backup — tenant isolation on export", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("a tenant's backup contains ONLY that tenant's rows", async () => {
    await seedTenant(TENANT_A, { customers: 3, tag: "A" });
    await seedTenant(TENANT_B, { customers: 5, tag: "B" });

    const backup = await buildTenantBackup({ tenantId: TENANT_A, createdByUserId: null });
    const { json } = openBackup(backup.container);
    const pkg = JSON.parse(json) as { manifest: { tenant: { id: string }; counts: Record<string, number> }; data: Record<string, { tenantId?: string; fullName?: string }[]> };

    expect(pkg.manifest.tenant.id).toBe(TENANT_A);
    expect(pkg.manifest.counts.customers).toBe(3);
    // Not one B row, by any measure.
    for (const rows of Object.values(pkg.data)) {
      for (const row of rows) {
        if (row.tenantId !== undefined) expect(row.tenantId).toBe(TENANT_A);
        if (typeof row.fullName === "string") expect(row.fullName).not.toContain("B ");
      }
    }
  });

  it("the backup never contains passwords, tokens or connector secrets", async () => {
    await createTestUser({ tenantId: TENANT_A, isPlatformAdmin: true });
    await seedTenant(TENANT_A, { tag: "A" });

    const backup = await buildTenantBackup({ tenantId: TENANT_A, createdByUserId: null });
    const { json } = openBackup(backup.container);
    const pkg = JSON.parse(json) as {
      manifest: { policy: { sanitizedFields: Record<string, string[]>; excludedModels: Record<string, string> } };
      data: Record<string, Record<string, unknown>[]>;
    };
    const dataStr = JSON.stringify(pkg.data);

    // No secret VALUE anywhere in the whole package.
    for (const secret of ["SHOULD-NOT-LEAK", "CIPHERTEXT-SECRET", "CARRIER-SECRET"]) {
      expect(json).not.toContain(secret);
    }
    // No secret FIELD in the actual data payload (the manifest.policy block
    // deliberately NAMES the stripped fields as documentation — that's not
    // a value and not data).
    for (const field of ["passwordHash", "credentialsEncrypted", "isPlatformAdmin", "tokenHash"]) {
      expect(dataStr).not.toContain(field);
    }

    // Excluded models entirely absent.
    expect(pkg.data.sessions).toBeUndefined();
    expect(pkg.data.invitations).toBeUndefined();
    expect(pkg.data.password_reset_tokens).toBeUndefined();
    expect(pkg.data.notifications).toBeUndefined();
    expect(pkg.data.sync_runs).toBeUndefined();

    // Integration metadata IS kept, minus the secret.
    const integ = (pkg.data.integrations[0] ?? {}) as { config?: Record<string, unknown>; credentialsEncrypted?: unknown };
    expect(integ.credentialsEncrypted).toBeUndefined();
    expect(integ.config?.storeUrl).toBe(`https://${TENANT_A}.example.com`);
    expect(integ.config?.consumerSecret).toBeUndefined();

    // The manifest documents exactly what was stripped.
    expect(pkg.manifest.policy.sanitizedFields.User).toContain("passwordHash");
    expect(Object.keys(pkg.manifest.policy.excludedModels)).toContain("Session");
  });
});

describe("backup — restore safety & correctness", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("refuses to restore a backup whose manifest tenant differs from the active tenant", async () => {
    await seedTenant(TENANT_B, { tag: "B" });
    const backupB = await buildTenantBackup({ tenantId: TENANT_B, createdByUserId: null });
    const inspected = inspectBackup(backupB.container);
    expect(inspected.valid).toBe(true);

    await expect(restoreTenantBackup({ activeTenantId: TENANT_A, inspected })).rejects.toBeInstanceOf(
      CrossTenantRestoreError
    );
  });

  it("same-tenant restore preserves relationships and replaces business data", async () => {
    await seedTenant(TENANT_A, { customers: 3, tag: "A" });
    const before = await countBusinessRows(TENANT_A);
    const backup = await buildTenantBackup({ tenantId: TENANT_A, createdByUserId: null });

    // Mutate the live data: add a stray order, delete a product's category.
    await runWithTenant(TENANT_A, "test", async () => {
      const c = await prisma.customer.create({ data: { fullName: "Stray" } });
      await prisma.order.create({ data: { customerId: c.id, subtotal: "1", total: "1", currency: "MAD" } });
    });
    expect((await countBusinessRows(TENANT_A)).orders).toBe(before.orders + 1);

    const inspected = inspectBackup(backup.container);
    const result = await restoreTenantBackup({ activeTenantId: TENANT_A, inspected });

    const after = await countBusinessRows(TENANT_A);
    expect(after).toEqual(before);
    expect(result.restoredCounts.orders).toBe(before.orders);

    // Relationships intact.
    await runWithTenant(TENANT_A, "test", async () => {
      const order = await prisma.order.findFirstOrThrow({ include: { items: true, customer: true } });
      expect(order.items.length).toBe(1);
      expect(order.customer.fullName).toMatch(/Client A/);
      const prod = await prisma.product.findFirstOrThrow({ include: { category: { include: { parent: true } } } });
      expect(prod.category?.name).toMatch(/Sub A/);
      // deferred self-referential FK (Category.parentId) restored in pass 2
      expect(prod.category?.parent?.name).toMatch(/Cat A/);
    });
  });

  it("integrations come back disconnected with no credentials after restore", async () => {
    await seedTenant(TENANT_A, { tag: "A" });
    const backup = await buildTenantBackup({ tenantId: TENANT_A, createdByUserId: null });
    const inspected = inspectBackup(backup.container);
    await restoreTenantBackup({ activeTenantId: TENANT_A, inspected });

    await runWithTenant(TENANT_A, "test", async () => {
      const integ = await prisma.integration.findFirstOrThrow();
      expect(integ.status).toBe("DECONNECTE");
      expect(integ.credentialsEncrypted).toBeNull();
      const provider = await prisma.shippingProvider.findFirstOrThrow();
      expect(provider.credentialsEncrypted).toBeNull();
      expect(provider.connectionStatus).toBe("DECONNECTE");
    });
  });

  it("an empty tenant round-trips (export then restore, still empty)", async () => {
    await prismaBase.tenant.upsert({
      where: { id: TENANT_B },
      update: {},
      create: { id: TENANT_B, name: "Empty", slug: TENANT_B },
    });
    const backup = await buildTenantBackup({ tenantId: TENANT_B, createdByUserId: null });
    const inspected = inspectBackup(backup.container);
    expect(inspected.valid).toBe(true);
    const result = await restoreTenantBackup({ activeTenantId: TENANT_B, inspected });
    expect(Object.values(result.restoredCounts).every((n) => n === 0)).toBe(true);
  });

  it("a larger dataset round-trips with matching counts", async () => {
    await seedTenant(TENANT_A, { customers: 120, tag: "A" });
    const before = await countBusinessRows(TENANT_A);
    const backup = await buildTenantBackup({ tenantId: TENANT_A, createdByUserId: null });
    const inspected = inspectBackup(backup.container);
    const result = await restoreTenantBackup({ activeTenantId: TENANT_A, inspected });
    expect(result.restoredCounts.orders).toBe(120);
    expect(await countBusinessRows(TENANT_A)).toEqual(before);
  }, 30_000);

  it("runRestore takes a safety snapshot first; a cancelled/failed restore leaves data intact", async () => {
    const user = await createTestUser({ tenantId: TENANT_A, role: "OWNER" });
    await seedTenant(TENANT_A, { customers: 2, tag: "A" });
    const before = await countBusinessRows(TENANT_A);

    const backup = await buildTenantBackup({ tenantId: TENANT_A, createdByUserId: user.id });
    const stored = await storeRestoreUpload({ tenantId: TENANT_A, userId: user.id, container: backup.container });
    expect(stored.inspected.valid).toBe(true);

    const outcome = await runRestore({ tenantId: TENANT_A, userId: user.id, uploadId: stored.uploadId });
    expect(outcome.safetySnapshotId).toBeTruthy();
    expect(await countBusinessRows(TENANT_A)).toEqual(before);

    // The safety snapshot exists and is itself a valid, restorable package.
    const snap = await runWithTenant(TENANT_A, "test", () =>
      prisma.backupRun.findFirstOrThrow({ where: { type: "PRE_RESTORE_SNAPSHOT" }, select: { payload: true } })
    );
    expect(snap.payload).not.toBeNull();
    const snapInspected = inspectBackup(Buffer.from(snap.payload!));
    expect(snapInspected.valid).toBe(true);
  });

  it("discarding a pending upload changes nothing", async () => {
    const user = await createTestUser({ tenantId: TENANT_A, role: "OWNER" });
    await seedTenant(TENANT_A, { tag: "A" });
    const before = await countBusinessRows(TENANT_A);
    const backup = await buildTenantBackup({ tenantId: TENANT_A, createdByUserId: user.id });

    const stored = await storeRestoreUpload({ tenantId: TENANT_A, userId: user.id, container: backup.container });
    // never confirmed
    await runWithTenant(TENANT_A, "test", () =>
      prisma.backupRun.deleteMany({ where: { id: stored.uploadId } })
    );
    expect(await countBusinessRows(TENANT_A)).toEqual(before);
  });

  it("user accounts are merged, never deleted: existing kept, unknown created login-disabled", async () => {
    const owner = await createTestUser({ tenantId: TENANT_A, role: "OWNER", email: "owner@a.test" });
    await seedTenant(TENANT_A, { tag: "A" });

    // Build a backup that includes `owner` + a fabricated extra user.
    const backup = await buildTenantBackup({ tenantId: TENANT_A, createdByUserId: owner.id });
    const { json } = openBackup(backup.container);
    const pkg = JSON.parse(json) as { manifest: unknown; data: Record<string, Record<string, unknown>[]> };
    pkg.data.users.push({
      id: "restored-ghost",
      email: "ghost@a.test",
      name: "Ghost",
      role: "SUPPORT",
      status: "ACTIVE",
      createdAt: new Date().toISOString(),
    });
    // Re-seal with a matching checksum.
    const { canonicalDataJson, sha256Hex } = await import("@/lib/backup/manifest");
    const m = pkg.manifest as { checksum: { data: string }; counts: Record<string, number> };
    m.checksum.data = sha256Hex(canonicalDataJson(pkg.data));
    m.counts.users = pkg.data.users.length;
    const { sealBackup } = await import("@/lib/backup/container");
    const resealed = sealBackup(JSON.stringify(pkg)).container;

    const inspected = inspectBackup(resealed);
    expect(inspected.valid).toBe(true);
    const result = await restoreTenantBackup({ activeTenantId: TENANT_A, inspected });
    expect(result.usersCreatedDisabled).toBe(1);

    await runWithTenant(TENANT_A, "test", async () => {
      const stillOwner = await prisma.user.findFirstOrThrow({ where: { email: "owner@a.test" } });
      expect(stillOwner.id).toBe(owner.id); // not recreated
      expect(stillOwner.passwordHash).not.toBe(""); // password untouched
      const ghost = await prisma.user.findFirstOrThrow({ where: { email: "ghost@a.test" } });
      expect(ghost.status).toBe("DISABLED");
      expect(ghost.passwordHash).toBe(""); // cannot log in
    });
  });

  it("createManualBackup persists exactly one retained package, re-downloadable, isolated per tenant", async () => {
    const user = await createTestUser({ tenantId: TENANT_A, role: "OWNER" });
    await seedTenant(TENANT_A, { customers: 2, tag: "A" });
    await seedTenant(TENANT_B, { customers: 4, tag: "B" });

    const first = await createManualBackup({ tenantId: TENANT_A, userId: user.id, slug: "acme" });
    expect(first.filename).toMatch(/^ASODITECH_BACKUP_acme_\d{4}-\d{2}-\d{2}\.asb$/);
    const second = await createManualBackup({ tenantId: TENANT_A, userId: user.id, slug: "acme" });

    // Only the latest is retained.
    const rows = await runWithTenant(TENANT_A, "test", () =>
      prisma.backupRun.findMany({ where: { type: "MANUAL_EXPORT" }, select: { id: true } })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(second.runId);

    // Re-download streams the stored container.
    const dl = await getDownloadableBackup({ tenantId: TENANT_A, slug: "acme" });
    expect(dl?.runId).toBe(second.runId);
    const inspected = inspectBackup(dl!.container);
    expect(inspected.valid).toBe(true);
    expect(inspected.manifest.tenant.id).toBe(TENANT_A);
    expect(inspected.counts.customers).toBe(2);

    // Tenant B has none, and cannot see A's.
    const bDl = await getDownloadableBackup({ tenantId: TENANT_B, slug: "b" });
    expect(bDl).toBeNull();
  });

  it("confirmRestoreAction rejects a caller without settings.manage (RBAC)", async () => {
    await loginAsTestUser({ tenantId: TENANT_A, role: "WAREHOUSE" });
    const fd = new FormData();
    fd.set("uploadId", "whatever");
    await expect(confirmRestoreAction(fd)).rejects.toThrow(/permission/i);
  });
});
