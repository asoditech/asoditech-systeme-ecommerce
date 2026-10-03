import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { createSession, getCurrentUser, type CurrentUser } from "@/lib/auth/session";
import { verifyPassword } from "@/lib/auth/password";
import { requirePlatformAdmin, requirePlatformAdminForAction } from "@/lib/auth/guards";
import { hasPlatformUnlock, PLATFORM_UNLOCK_COOKIE } from "@/lib/auth/platform-access";
import { TenantIsolationError } from "@/lib/tenant/extension";
import { checkAndNotifyUsageThreshold } from "@/lib/entitlements/alerts";
import { previewTenantPurge, deleteTenantData, TenantNotPurgeableError } from "@/lib/tenant/delete";
import { getPlatformUsage } from "@/lib/queries/platform-usage";
import { sendPasswordResetEmail } from "@/lib/email";
import { loginAction } from "@/actions/auth";
import { unlockPlatformAction } from "@/actions/platform-access";
import { forcePasswordResetAction } from "@/actions/password-reset";
import { deleteTenantAction, listTenantsForPlatform, previewTenantPurgeAction } from "@/actions/tenants";
import { cancelOrderAction } from "@/actions/orders";
import { updateCustomerAction } from "@/actions/customers";
import { updateSupplierAction } from "@/actions/purchases";
import { listOrders, getOrderDetail } from "@/lib/queries/orders";
import { listCustomers } from "@/lib/queries/customers";
import { listProducts } from "@/lib/queries/products";
import { listInventoryItems } from "@/lib/queries/inventory";
import { listSuppliers } from "@/lib/queries/purchases";
import { listSales } from "@/lib/queries/sales";
import { listAuditJournal } from "@/lib/queries/audit";
import { getChannelReport } from "@/lib/queries/reports/channels";
import { GET as exportStock } from "@/app/(protected)/stock/export/route";
import { GET as exportAnalytics } from "@/app/(protected)/analyses/export/[type]/route";
import { DEFAULT_TENANT_ID, markTenantTrial, resetDb, setTestBusinessMode } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { RedirectSignal } from "../setup";

/**
 * Production-trial hardening — docs/adr/0053: R1 (no cross-tenant audit
 * writes), R2 (fail-closed tenant context), platform step-up access, forced
 * password reset, trial-only purge with dry-run + zero-row proof, platform
 * usage, and a two-way tenant isolation matrix through the REAL session path.
 */

const A = DEFAULT_TENANT_ID;
const B = "tenant-b-0053";
const PASSWORD = "correct-horse-battery-staple"; // createTestUser's fixture password
const KEY = "platform-key-0053-" + "x".repeat(40);
const KEY_SHA = createHash("sha256").update(KEY).digest("hex");

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  await prismaBase.tenant.create({ data: { id: B, name: "Client B", slug: B } });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await resetDb();
  mockCookieStore.clear();
});

const fd = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
async function as(user: { id: string }): Promise<CurrentUser> {
  mockCookieStore.clear();
  await createSession(user.id);
  return (await getCurrentUser())!;
}
const settle = <T,>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));

/** One tenant's world: everything the isolation matrix reads, tagged with `M`. */
async function seedTenant(tenantId: string, M: string) {
  const wh = await prismaBase.warehouse.create({ data: { tenantId, name: `Entrepôt-${M}`, isDefault: true } });
  const product = await prismaBase.product.create({ data: { tenantId, name: `Produit-${M}`, sku: `SKU-${M}`, price: 100, cost: 40, status: "ACTIF" } });
  await prismaBase.inventoryItem.create({ data: { tenantId, warehouseId: wh.id, productId: product.id, quantityOnHand: 5 } });
  const customer = await prismaBase.customer.create({ data: { tenantId, fullName: `Client-${M}`, phone: `06000000${M === "A" ? "11" : "22"}` } });
  const order = await prismaBase.order.create({
    data: {
      tenantId,
      customerId: customer.id,
      subtotal: 100,
      total: 100,
      items: { create: [{ tenantId, productId: product.id, nameSnapshot: `Produit-${M}`, skuSnapshot: `SKU-${M}`, unitPrice: 100, quantity: 1, total: 100 }] },
    },
  });
  const supplier = await prismaBase.supplier.create({ data: { tenantId, name: `Fournisseur-${M}` } });
  const store = await prismaBase.salesChannel.create({ data: { tenantId, name: `Boutique-${M}`, kind: "OFFLINE" } });
  await prismaBase.sale.create({
    data: { tenantId, salesChannelId: store.id, warehouseId: wh.id, idempotencyKey: randomUUID(), subtotal: 77, total: 77, customerLabel: `Vente-${M}` },
  });
  const admin = await createTestUser({ tenantId, role: "ADMIN", email: `admin-${M.toLowerCase()}@client.test` });
  await prismaBase.auditEvent.create({ data: { tenantId, actorType: "SYSTEM", action: "user.login.success", entityType: "User", entityId: `marker-${M}` } });
  return { wh, product, customer, order, supplier, admin };
}

// ---------------------------------------------------------------------------
// R1 — no audit event ever lands in another (or the bootstrap) tenant
// ---------------------------------------------------------------------------

describe("R1 — login failures are audited only in the tenant that owns the account", () => {
  it("unknown e-mail: no audit row in ANY tenant; a known e-mail in B: only B, only B's user", async () => {
    await createTestUser({ tenantId: B, role: "MANAGER", email: "staff@client-b.test" });
    const r1 = await loginAction(undefined, fd({ email: "nobody@nowhere.test", password: "whatever-123" }));
    expect(r1.ok).toBe(false);
    expect(await prismaBase.auditEvent.count({ where: { action: "user.login.failure" } })).toBe(0);

    await loginAction(undefined, fd({ email: "staff@client-b.test", password: "wrong-password-1" }));
    const rows = await prismaBase.auditEvent.findMany({ where: { action: "user.login.failure" } });
    expect(rows.map((r) => r.tenantId)).toEqual([B]);
    expect(await prismaBase.auditEvent.count({ where: { tenantId: A, action: "user.login.failure" } })).toBe(0);
  });

  it("same e-mail in two tenants: each tenant gets ONLY its own user's failure", async () => {
    const a = await createTestUser({ tenantId: A, role: "MANAGER", email: "shared@client.test" });
    const b = await createTestUser({ tenantId: B, role: "MANAGER", email: "shared@client.test" });
    await loginAction(undefined, fd({ email: "shared@client.test", password: "wrong-password-1" }));
    const rows = await prismaBase.auditEvent.findMany({ where: { action: "user.login.failure" }, select: { tenantId: true, entityId: true } });
    expect(rows.sort((x, y) => x.tenantId.localeCompare(y.tenantId))).toEqual(
      [{ tenantId: A, entityId: a.id }, { tenantId: B, entityId: b.id }].sort((x, y) => x.tenantId.localeCompare(y.tenantId))
    );
  });
});

// ---------------------------------------------------------------------------
// R2 — fail-closed tenant context
// ---------------------------------------------------------------------------

describe("R2 — no default-tenant fallback in production", () => {
  it("a read and a write with no context are refused (production); usage alerts pin their own tenant", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(prisma.order.findMany()).rejects.toThrow(/no tenant context/);
    await expect(prisma.customer.create({ data: { fullName: "X" } })).rejects.toThrow(/no tenant context/);
    // invitation acceptance / webhooks run without a session: the alert still lands in B, not in A
    await checkAndNotifyUsageThreshold(B, "USERS", { used: 9, limit: 10, percent: 90 } as never);
    vi.unstubAllEnvs();
    expect(await prismaBase.usageAlertState.findMany({ select: { tenantId: true } })).toEqual([{ tenantId: B }]);
  });
});

// ---------------------------------------------------------------------------
// Platform step-up access
// ---------------------------------------------------------------------------

describe("platform access — step-up key", () => {
  async function platformAdmin() {
    return createTestUser({ tenantId: A, role: "OWNER", isPlatformAdmin: true });
  }

  it("with a key configured: locked until unlocked, wrong key refused and audited, right key unlocks", async () => {
    vi.stubEnv("PLATFORM_ACCESS_KEY_SHA256", KEY_SHA);
    const admin = await platformAdmin();
    await as(admin);
    await expect(requirePlatformAdminForAction()).rejects.toThrow(/verrouillé/);
    const page = await settle(requirePlatformAdmin());
    expect(page.ok).toBe(false);
    expect((page as { e: Error }).e).toBeInstanceOf(RedirectSignal);
    expect(((page as { e: Error }).e as Error).message).toContain("/acces-plateforme");

    expect((await unlockPlatformAction(undefined, fd({ key: "wrong" })))?.ok).toBe(false);
    expect(await prismaBase.auditEvent.count({ where: { action: "platform.unlock.failure", tenantId: A } })).toBe(1);
    expect(mockCookieStore.get(PLATFORM_UNLOCK_COOKIE)).toBeUndefined();

    const ok = await settle(unlockPlatformAction(undefined, fd({ key: KEY })));
    expect((ok as { e: Error }).e).toBeInstanceOf(RedirectSignal); // redirect("/platform")
    expect(await hasPlatformUnlock(admin.id)).toBe(true);
    await expect(requirePlatformAdminForAction()).resolves.toMatchObject({ id: admin.id });
    // the key itself is never stored or logged in the audit trail
    expect(JSON.stringify(await prismaBase.auditEvent.findMany())).not.toContain(KEY);
  });

  it("the unlock is bound to the session and to the key: a new session or a rotated key re-locks", async () => {
    vi.stubEnv("PLATFORM_ACCESS_KEY_SHA256", KEY_SHA);
    const admin = await platformAdmin();
    await as(admin);
    await settle(unlockPlatformAction(undefined, fd({ key: KEY })));
    const unlock = mockCookieStore.get(PLATFORM_UNLOCK_COOKIE)!.value;
    expect(await hasPlatformUnlock(admin.id)).toBe(true);
    // another session with the copied unlock cookie
    await createSession(admin.id);
    mockCookieStore.set(PLATFORM_UNLOCK_COOKIE, unlock);
    expect(await hasPlatformUnlock(admin.id)).toBe(false);
    // rotation
    await settle(unlockPlatformAction(undefined, fd({ key: KEY })));
    expect(await hasPlatformUnlock(admin.id)).toBe(true);
    vi.stubEnv("PLATFORM_ACCESS_KEY_SHA256", createHash("sha256").update("rotated-key-" + "y".repeat(40)).digest("hex"));
    expect(await hasPlatformUnlock(admin.id)).toBe(false);
  });

  it("production with NO key configured is locked (fail-closed); a customer OWNER can never unlock", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const admin = await platformAdmin();
    await as(admin);
    expect(await hasPlatformUnlock(admin.id)).toBe(false);
    expect((await unlockPlatformAction(undefined, fd({ key: KEY })))?.ok).toBe(false);
    vi.unstubAllEnvs();

    vi.stubEnv("PLATFORM_ACCESS_KEY_SHA256", KEY_SHA);
    const owner = await createTestUser({ tenantId: B, role: "OWNER" });
    await as(owner);
    expect((await unlockPlatformAction(undefined, fd({ key: KEY })))?.ok).toBe(false);
    for (const call of [() => listTenantsForPlatform(), () => previewTenantPurgeAction(B), () => forcePasswordResetAction(fd({ userId: owner.id }))]) {
      await expect(call()).rejects.toThrow(/plateforme/);
    }
  });
});

// ---------------------------------------------------------------------------
// Forced password reset — never reveals a password
// ---------------------------------------------------------------------------

describe("force password reset (platform owner)", () => {
  it("old password stops working, sessions end, a single-use token is issued, nothing secret is returned", async () => {
    const target = await createTestUser({ tenantId: B, role: "OWNER", email: "owner@client-b.test" });
    await createSession(target.id);
    const admin = await createTestUser({ tenantId: A, role: "OWNER", isPlatformAdmin: true });
    await as(admin);
    const result = await forcePasswordResetAction(fd({ userId: target.id }));
    expect(result).toEqual({ ok: true, data: undefined });
    const after = await prismaBase.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(await verifyPassword(PASSWORD, after.passwordHash)).toBe(false);
    expect(await prismaBase.session.count({ where: { userId: target.id } })).toBe(0);
    const tokens = await prismaBase.passwordResetToken.findMany({ where: { userId: target.id } });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ tenantId: B, usedAt: null });
    expect(tokens[0].expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000 + 1000);
    expect(await prismaBase.auditEvent.count({ where: { tenantId: B, action: "user.password_reset_forced" } })).toBe(1);
    // a platform admin account is refused
    expect((await forcePasswordResetAction(fd({ userId: admin.id }))).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Trial purge — dry-run, trial-only, zero-row proof
// ---------------------------------------------------------------------------

describe("trial purge", () => {
  it("dry-run counts without writing; refuses a regular customer, the bootstrap tenant and a tenant holding a platform admin", async () => {
    await seedTenant(B, "B");
    const before = await previewTenantPurge(B);
    expect(before.refusal).toMatch(/essai/);
    expect(before.counts).toMatchObject({ order: 1, product: 1, sale: 1, supplier: 1, user: 1 });
    await expect(deleteTenantData(B)).rejects.toBeInstanceOf(TenantNotPurgeableError);
    expect((await previewTenantPurge(A)).refusal).toMatch(/amorçage/);
    await markTenantTrial(B);
    expect((await previewTenantPurge(B)).refusal).toBeNull();
    await createTestUser({ tenantId: B, role: "OWNER", isPlatformAdmin: true });
    expect((await previewTenantPurge(B)).refusal).toMatch(/administrateur de la plateforme/);
    expect(await prismaBase.order.count({ where: { tenantId: B } })).toBe(1); // dry-run wrote nothing
  });

  it("purges a trial tenant (incl. physical returns) to ZERO rows and leaves the other tenant untouched", async () => {
    const a = await seedTenant(A, "A");
    const b = await seedTenant(B, "B");
    await prismaBase.orderReturn.create({
      data: { tenantId: B, orderId: b.order.id, idempotencyKey: randomUUID(), lines: { create: [{ tenantId: B, nameSnapshot: "Produit-B", skuSnapshot: "SKU-B", quantitySellable: 1, warehouseId: b.wh.id }] } },
    });
    await markTenantTrial(B);
    const admin = await createTestUser({ tenantId: A, role: "OWNER", isPlatformAdmin: true });
    await as(admin);
    expect((await previewTenantPurgeAction(B)).ok).toBe(true);
    const r = await deleteTenantAction(fd({ id: B, slugConfirmation: B }));
    expect(r.ok).toBe(true);
    expect(await prismaBase.tenant.findUnique({ where: { id: B } })).toBeNull();
    const after = await previewTenantPurge(B);
    expect(after.total).toBe(0);
    // tenant A intact
    expect(await prismaBase.order.count({ where: { id: a.order.id } })).toBe(1);
    expect(await prismaBase.product.count({ where: { tenantId: A } })).toBe(1);
    expect(await prismaBase.plan.count()).toBeGreaterThan(0);
    // the platform-side audit keeps the evidence the purged tenant's own journal lost
    const audit = await prismaBase.auditEvent.findFirstOrThrow({ where: { action: "tenant.deleted", entityId: B } });
    expect(audit.tenantId).toBe(A);
    expect(audit.metadata).toMatchObject({ subscription: { status: "TRIALING", statusChangedAt: expect.any(String) } });
  });
});

// ---------------------------------------------------------------------------
// Platform usage
// ---------------------------------------------------------------------------

describe("platform usage", () => {
  it("counts per tenant with one aggregate per table, and real DB sizes", async () => {
    await seedTenant(A, "A");
    await seedTenant(B, "B");
    await prismaBase.order.create({ data: { tenantId: B, customerId: (await prismaBase.customer.findFirstOrThrow({ where: { tenantId: B } })).id, subtotal: 1, total: 1 } });
    const u = await getPlatformUsage({ fresh: true });
    expect(u.rows.get(B)?.counts).toMatchObject({ orders: 2, products: 1, sales: 1, suppliers: 1, customers: 1, warehouses: 1, inventoryItems: 1 });
    expect(u.rows.get(A)?.counts.orders).toBe(1);
    expect(u.moduleTotals.find((m) => m.key === "orders")).toMatchObject({ total: 3, tenantsUsing: 2 });
    expect(u.database === null || u.database.totalBytes > 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation matrix — both directions, real session path
// ---------------------------------------------------------------------------

describe("tenant isolation — A ⇄ B", () => {
  for (const [ME, OTHER] of [["A", "B"], ["B", "A"]] as const) {
    it(`tenant ${ME} can neither read nor change tenant ${OTHER}`, async () => {
      await setTestBusinessMode("ONLINE_AND_OFFLINE", A);
      await setTestBusinessMode("ONLINE_AND_OFFLINE", B);
      const worlds = { A: await seedTenant(A, "A"), B: await seedTenant(B, "B") };
      const mine = worlds[ME];
      const theirs = worlds[OTHER];
      const me = await as(mine.admin);
      const foreign = new RegExp(`(Produit|Client|Fournisseur|Vente|Entrepôt)-${OTHER}|marker-${OTHER}|admin-${OTHER.toLowerCase()}@`);

      // reads: orders, products, inventory, sales, suppliers, customers, users, audit, reports
      const reads = {
        orders: await listOrders({}),
        orderDetail: await getOrderDetail(theirs.order.id),
        products: await listProducts({}, me),
        inventory: await listInventoryItems({}),
        sales: await listSales(me),
        suppliers: await listSuppliers({}, me),
        customers: await listCustomers({}),
        users: await prisma.user.findMany({ select: { email: true } }),
        audit: await listAuditJournal(me, {}),
        channelReport: await getChannelReport(me, { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 86_400_000) }, { kind: "offline" }),
      };
      expect(JSON.stringify(reads)).not.toMatch(foreign);
      expect(reads.orderDetail).toBeNull();
      expect(reads.orders.orders).toHaveLength(1);
      expect(reads.channelReport.offline?.grossSales).toBe(77);

      // foreign tenant id in a query or a write: refused
      const otherTenantId = OTHER === "A" ? A : B;
      await expect(prisma.product.findMany({ where: { tenantId: otherTenantId } })).rejects.toBeInstanceOf(TenantIsolationError);
      await expect(prisma.product.create({ data: { tenantId: otherTenantId, name: "x", sku: "x", price: 1 } })).rejects.toBeInstanceOf(TenantIsolationError);

      // server actions on the other tenant's ids: nothing changes
      await settle(cancelOrderAction(fd({ id: theirs.order.id, reason: "x" })));
      await settle(updateCustomerAction(fd({ id: theirs.customer.id, fullName: "PWNED", phone: "0611111111" })));
      await settle(updateSupplierAction({ id: theirs.supplier.id, name: "PWNED" } as never));
      expect((await prismaBase.order.findUniqueOrThrow({ where: { id: theirs.order.id } })).status).toBe("NOUVELLE");
      expect((await prismaBase.customer.findUniqueOrThrow({ where: { id: theirs.customer.id } })).fullName).toBe(`Client-${OTHER}`);
      expect((await prismaBase.supplier.findUniqueOrThrow({ where: { id: theirs.supplier.id } })).name).toBe(`Fournisseur-${OTHER}`);

      // direct URL: the other tenant's order page is a 404
      const { default: OrderPage } = await import("@/app/(protected)/commandes/[id]/page");
      await expect(OrderPage({ params: Promise.resolve({ id: theirs.order.id }) } as never)).rejects.toThrow("NEXT_NOT_FOUND");

      // API routes / exports
      const stockCsv = await (await exportStock(new Request("http://t/stock/export"))).text();
      expect(stockCsv).toContain(`Produit-${ME}`);
      expect(stockCsv).not.toMatch(foreign);
      const products = await exportAnalytics(new Request("http://t/analyses/export/produits?period=30d"), { params: Promise.resolve({ type: "produits" }) });
      expect(await products.text()).not.toMatch(foreign);

      // admin / customer boundary: a tenant ADMIN is not a platform admin
      await expect(listTenantsForPlatform()).rejects.toThrow(/plateforme/);
      await expect(deleteTenantAction(fd({ id: otherTenantId, slugConfirmation: otherTenantId }))).rejects.toThrow(/plateforme/);
    });
  }
});

describe("e-mail fallback never logs a live link in production", () => {
  it("unconfigured e-mail in production: the reset URL / token is not written to the log", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const token = "tok_" + "z".repeat(40);
    await sendPasswordResetEmail({ to: "someone@client.test", resetUrl: `/reinitialiser-mot-de-passe/${token}` });
    const logged = JSON.stringify([...log.mock.calls, ...warn.mock.calls]);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain("someone@client.test");
    expect(logged).toContain("NOT SENT");
    log.mockRestore();
    warn.mockRestore();
  });
});
