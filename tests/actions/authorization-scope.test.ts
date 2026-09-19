import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/session";
import { requireChannelKind, requireChannelKindForAction, requireChannelAccessForAction } from "@/lib/auth/channel-access";
import { auditScopeWhere } from "@/lib/auth/audit-scope";
import { setUserPermissionOverridesAction, setUserChannelsAction } from "@/actions/users";
import { createSalesChannelAction, setChannelLocationsAction, updateSalesChannelAction } from "@/actions/channels";
import { updateOrderStatusAction } from "@/actions/orders";
import { runAiToolAction } from "@/actions/ai";
import { notifyNewOrder } from "@/lib/notifications";
import { ensureDefaultOnlineChannel } from "@/lib/channels";
import { GET as exportReport } from "@/app/(protected)/rapports/export/[type]/route";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser, createTestUser, grantChannelAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Online/Offline authorization — docs/adr/0039: role baseline + per-user
 * GRANT/DENY overrides + channel scope, enforced SERVER-SIDE on reads and
 * writes (never by hiding a menu item).
 */

beforeEach(async () => {
  await resetDb();
  // These suites cover the Offline capabilities, which exist only in an
  // ONLINE_AND_OFFLINE tenant (docs/adr/0041).
  await setTestBusinessMode("ONLINE_AND_OFFLINE");
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

async function makeStore(name = "Magasin A") {
  return prisma.salesChannel.create({ data: { name, kind: "OFFLINE" } });
}

/** A MANAGER with ONLY the given channels (zero by default), logged in. */
async function loginScopedManager(channelIds: string[]) {
  const u = await loginAsTestUser({ role: "MANAGER", channels: "none" });
  if (channelIds.length > 0) await grantChannelAccess(u.id, channelIds);
  return u;
}

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

describe("effective permissions reach the server-side guards", () => {
  it("role baseline: a CONFIRMATION agent cannot cancel orders", async () => {
    await loginAsTestUser({ role: "CONFIRMATION" });
    await expect(requirePermissionForAction("orders.cancel")).rejects.toThrow(/non autorisé/i);
    await expect(requirePermissionForAction("orders.confirm")).resolves.toBeDefined();
  });

  it("a user GRANT gives that ONE user the extra permission — without touching the role", async () => {
    const sara = await loginAsTestUser({ role: "CONFIRMATION" });
    const other = await createTestUser({ role: "CONFIRMATION" });
    await prisma.userPermissionOverride.create({ data: { userId: sara.id, permission: "orders.cancel", effect: "GRANT" } });

    await expect(requirePermissionForAction("orders.cancel")).resolves.toBeDefined();
    // the ROLE is unchanged, and another agent of the same role is unaffected
    mockCookieStore.clear();
    const { createSession } = await import("@/lib/auth/session");
    await createSession(other.id);
    await expect(requirePermissionForAction("orders.cancel")).rejects.toThrow(/non autorisé/i);
  });

  it("a user DENY removes a permission the role grants", async () => {
    const u = await loginAsTestUser({ role: "MANAGER" });
    await requirePermissionForAction("inventory.transfer");
    await prisma.userPermissionOverride.create({ data: { userId: u.id, permission: "inventory.transfer", effect: "DENY" } });
    await expect(requirePermissionForAction("inventory.transfer")).rejects.toThrow(/non autorisé/i);
  });

  it("DENY overrides GRANT (a user cannot hold both — the stored DENY wins over the role's grant)", async () => {
    const u = await loginAsTestUser({ role: "ACCOUNTANT" }); // role grants finance.manage
    await prisma.userPermissionOverride.create({ data: { userId: u.id, permission: "finance.manage", effect: "DENY" } });
    await expect(requirePermissionForAction("finance.manage")).rejects.toThrow(/non autorisé/i);
    await expect(requirePermissionForAction("finance.view")).resolves.toBeDefined();
  });

  it("OWNER/ADMIN cannot be narrowed by an override row (lock-out protection)", async () => {
    const admin = await loginAsTestUser({ role: "ADMIN" });
    await prisma.userPermissionOverride.create({ data: { userId: admin.id, permission: "users.manage", effect: "DENY" } });
    await expect(requirePermissionForAction("users.manage")).resolves.toBeDefined();
  });

  it("the resolved user carries effective permissions + channel access", async () => {
    const store = await makeStore();
    await loginScopedManager([store.id]);
    const user = await getCurrentUser();
    expect(user?.permissions.has("sales.create")).toBe(true);
    expect(user?.permissions.has("orders.view")).toBe(false);
    expect(user?.channels).toMatchObject({ online: false, offline: true, global: false });
  });
});

describe("channel scope — direct server-action / page / export access is denied, not just hidden", () => {
  it("an OFFLINE-only manager cannot reach Online order actions even by calling them directly", async () => {
    const store = await makeStore();
    await loginScopedManager([store.id]);
    await expect(
      updateOrderStatusAction(fd({ id: "whatever", status: "CONFIRMEE" }))
    ).rejects.toThrow(/non autorisé/i);
  });

  it("an OFFLINE-only manager is refused the Online AI tools (shared finance.view permission is not enough)", async () => {
    const store = await makeStore();
    await loginScopedManager([store.id]);
    // MANAGER holds ai.use and finance.view — but the revenue tool reads Online orders.
    await prisma.userPermissionOverride.create({
      data: { userId: (await getCurrentUser())!.id, permission: "finance.view", effect: "GRANT" },
    });
    const result = await runAiToolAction("revenue");
    expect(result.ok).toBe(false);
  });

  it("an ONLINE-capable user can run the same Online AI tool", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const result = await runAiToolAction("revenue");
    expect(result.ok).toBe(true);
  });

  it("CSV export of an order-derived report is refused to a user without an ONLINE channel", async () => {
    const store = await makeStore();
    await loginScopedManager([store.id]); // MANAGER holds analytics.view
    await expect(
      exportReport(new Request("http://localhost/rapports/export/ventes"), { params: Promise.resolve({ type: "ventes" }) })
    ).rejects.toThrow(/acces-refuse/);
  });

  it("…while the stock export stays open (it is shared data)", async () => {
    const store = await makeStore();
    await loginScopedManager([store.id]);
    const res = await exportReport(new Request("http://localhost/rapports/export/stock"), {
      params: Promise.resolve({ type: "stock" }),
    });
    expect(res.status).toBe(200);
  });

  it("page/action helpers: requireChannelKind redirects, requireChannelKindForAction throws", async () => {
    const store = await makeStore();
    await loginScopedManager([store.id]);
    const user = (await getCurrentUser())!;
    expect(() => requireChannelKind(user, "ONLINE")).toThrow(/acces-refuse/);
    expect(() => requireChannelKindForAction(user, "ONLINE")).toThrow(/non autorisé/i);
    expect(() => requireChannelKind(user, "OFFLINE")).not.toThrow();
  });

  it("requireChannelAccessForAction: a user assigned to Store A cannot act on Store B, or on an Online channel as an offline one", async () => {
    const a = await makeStore("Magasin A");
    const b = await makeStore("Magasin B");
    const online = await ensureDefaultOnlineChannel();
    await loginScopedManager([a.id]);
    const user = (await getCurrentUser())!;
    await expect(requireChannelAccessForAction(user, a.id, { kind: "OFFLINE" })).resolves.toMatchObject({ id: a.id });
    await expect(requireChannelAccessForAction(user, b.id)).rejects.toThrow(/attribué/i);
    await expect(requireChannelAccessForAction(user, online.id, { kind: "OFFLINE" })).rejects.toThrow();
    await expect(requireChannelAccessForAction(user, "no-such-channel")).rejects.toThrow(/introuvable/i);
  });

  it("a combined (Online + Offline) user reaches both activities", async () => {
    const store = await makeStore();
    const online = await ensureDefaultOnlineChannel();
    await loginScopedManager([online.id, store.id]);
    const user = (await getCurrentUser())!;
    expect(user.channels).toMatchObject({ online: true, offline: true });
    await expect(requirePermissionForAction("orders.view")).resolves.toBeDefined();
    await expect(requirePermissionForAction("sales.create")).resolves.toBeDefined();
  });

  it("OWNER/ADMIN reach every channel without any assignment row", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const user = (await getCurrentUser())!;
    expect(user.channels.global).toBe(true);
    expect(() => requireChannelKind(user, "OFFLINE")).not.toThrow();
    expect(() => requireChannelKind(user, "ONLINE")).not.toThrow();
  });
});

describe("notifications respect effective access", () => {
  const order = {
    id: "o1",
    orderNumber: 1,
    displayNumber: 1,
    total: "100",
    currency: "MAD",
    customerName: "Client",
    source: "INTERNE" as const,
  };

  it("an OFFLINE-only manager does NOT receive Online order notifications; an Online manager does", async () => {
    const store = await makeStore();
    const onlineMgr = await createTestUser({ role: "MANAGER" });
    const offlineMgr = await createTestUser({ role: "MANAGER", channels: "none" });
    await grantChannelAccess(offlineMgr.id, store.id);

    await notifyNewOrder(order);

    const got = (await prisma.notification.findMany()).map((n) => n.userId);
    expect(got).toContain(onlineMgr.id);
    expect(got).not.toContain(offlineMgr.id);
  });

  it("a per-user GRANT of orders.view makes an Online user a recipient; a DENY removes them", async () => {
    const granted = await createTestUser({ role: "DELIVERY", channels: "default-online" }); // has orders.view by role
    const denied = await createTestUser({ role: "MANAGER" });
    await prisma.userPermissionOverride.create({ data: { userId: denied.id, permission: "orders.view", effect: "DENY" } });

    await notifyNewOrder(order);
    const got = (await prisma.notification.findMany()).map((n) => n.userId);
    expect(got).toContain(granted.id);
    expect(got).not.toContain(denied.id);
  });
});

describe("audit log read scope", () => {
  async function seedAudit() {
    await prisma.auditEvent.createMany({
      data: [
        { actorType: "SYSTEM", action: "order.created", entityType: "Order", entityId: "o1" },
        { actorType: "SYSTEM", action: "sale.created", entityType: "Sale", entityId: "s1" },
        { actorType: "SYSTEM", action: "product.updated", entityType: "Product", entityId: "p1" },
      ],
    });
  }
  const actions = async (scope: ReturnType<typeof auditScopeWhere>) =>
    (await prisma.auditEvent.findMany({ where: scope })).map((e) => e.action).sort();

  it("OFFLINE-only sees sale + shared events, never Online ones", async () => {
    await seedAudit();
    expect(await actions(auditScopeWhere({ global: false, online: false, offline: true }))).toEqual([
      "product.updated",
      "sale.created",
    ]);
  });
  it("ONLINE-only sees order + shared events, never Offline ones", async () => {
    await seedAudit();
    expect(await actions(auditScopeWhere({ global: false, online: true, offline: false }))).toEqual([
      "order.created",
      "product.updated",
    ]);
  });
  it("combined and global users see everything", async () => {
    await seedAudit();
    expect((await actions(auditScopeWhere({ global: false, online: true, offline: true }))).length).toBe(3);
    expect((await actions(auditScopeWhere({ global: true, online: true, offline: true }))).length).toBe(3);
  });
});

describe("setUserPermissionOverridesAction", () => {
  it("replaces the set as a diff, stores only what is submitted, and audits it", async () => {
    const admin = await loginAsTestUser({ role: "ADMIN" });
    const sara = await createTestUser({ role: "CONFIRMATION" });

    const r1 = await setUserPermissionOverridesAction({
      userId: sara.id,
      grants: ["inventory.view", "orders.return"],
      denies: ["customers.edit"],
    });
    expect(r1.ok).toBe(true);
    let rows = await prisma.userPermissionOverride.findMany({ where: { userId: sara.id } });
    expect(rows.map((x) => `${x.effect}:${x.permission}`).sort()).toEqual([
      "DENY:customers.edit",
      "GRANT:inventory.view",
      "GRANT:orders.return",
    ]);

    // second submission removes one, flips one
    const r2 = await setUserPermissionOverridesAction({ userId: sara.id, grants: ["inventory.view"], denies: ["orders.return"] });
    expect(r2.ok).toBe(true);
    rows = await prisma.userPermissionOverride.findMany({ where: { userId: sara.id } });
    expect(rows.map((x) => `${x.effect}:${x.permission}`).sort()).toEqual(["DENY:orders.return", "GRANT:inventory.view"]);

    const audit = await prisma.auditEvent.findMany({ where: { action: "user.permissions_updated", entityId: sara.id } });
    expect(audit).toHaveLength(2);
    expect(audit[0].actorUserId).toBe(admin.id);
  });

  it("refuses to grant users.manage (privilege escalation), an unknown permission, and a grant+deny of the same permission", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const u = await createTestUser({ role: "MANAGER" });
    expect((await setUserPermissionOverridesAction({ userId: u.id, grants: ["users.manage"], denies: [] })).ok).toBe(false);
    expect((await setUserPermissionOverridesAction({ userId: u.id, grants: ["orders.teleport"], denies: [] })).ok).toBe(false);
    expect((await setUserPermissionOverridesAction({ userId: u.id, grants: ["finance.view"], denies: ["finance.view"] })).ok).toBe(false);
    expect(await prisma.userPermissionOverride.count()).toBe(0);
  });

  it("refuses to target an OWNER/ADMIN (they cannot be narrowed)", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const admin = await createTestUser({ role: "ADMIN" });
    const r = await setUserPermissionOverridesAction({ userId: admin.id, grants: [], denies: ["orders.view"] });
    expect(r.ok).toBe(false);
  });

  it("is itself protected server-side: only users.manage may call it (a manager cannot escalate themselves)", async () => {
    const mgr = await loginAsTestUser({ role: "MANAGER" });
    await expect(
      setUserPermissionOverridesAction({ userId: mgr.id, grants: ["settings.manage"], denies: [] })
    ).rejects.toThrow(/non autorisé/i);
  });

  it("cannot reach another tenant's user — not found", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await prismaBase.tenant.create({ data: { id: "tenant-b-authz", name: "B", slug: "tenant-b-authz" } });
    const foreign = await createTestUser({ role: "MANAGER", tenantId: "tenant-b-authz", channels: "none" });
    const r = await setUserPermissionOverridesAction({ userId: foreign.id, grants: ["finance.view"], denies: [] });
    expect(r.ok).toBe(false);
    expect(await prismaBase.userPermissionOverride.count({ where: { userId: foreign.id } })).toBe(0);
  });
});

describe("setUserChannelsAction", () => {
  it("assigns and removes channels as a diff and audits it", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const store = await makeStore();
    const online = await ensureDefaultOnlineChannel();
    const u = await createTestUser({ role: "MANAGER", channels: "none" });

    expect((await setUserChannelsAction({ userId: u.id, salesChannelIds: [online.id, store.id] })).ok).toBe(true);
    expect(await prisma.userChannel.count({ where: { userId: u.id } })).toBe(2);
    expect((await setUserChannelsAction({ userId: u.id, salesChannelIds: [store.id] })).ok).toBe(true);
    expect((await prisma.userChannel.findMany({ where: { userId: u.id } })).map((c) => c.salesChannelId)).toEqual([store.id]);
    expect(await prisma.auditEvent.count({ where: { action: "user.channels_updated", entityId: u.id } })).toBe(2);
  });

  it("drops an unknown / foreign / inactive channel id silently, and refuses an OWNER/ADMIN target", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const u = await createTestUser({ role: "MANAGER", channels: "none" });
    await prismaBase.tenant.create({ data: { id: "tenant-b-chan2", name: "B", slug: "tenant-b-chan2" } });
    const foreign = await prismaBase.salesChannel.create({
      data: { name: "Autre", kind: "OFFLINE", tenantId: "tenant-b-chan2" },
    });
    const inactive = await prisma.salesChannel.create({ data: { name: "Fermé", kind: "OFFLINE", isActive: false } });
    const r = await setUserChannelsAction({ userId: u.id, salesChannelIds: [foreign.id, inactive.id, "nope"] });
    expect(r.ok).toBe(true);
    expect(await prisma.userChannel.count({ where: { userId: u.id } })).toBe(0);

    const admin = await createTestUser({ role: "ADMIN" });
    expect((await setUserChannelsAction({ userId: admin.id, salesChannelIds: [] })).ok).toBe(false);
  });

  it("requires users.manage", async () => {
    const mgr = await loginAsTestUser({ role: "MANAGER" });
    await expect(setUserChannelsAction({ userId: mgr.id, salesChannelIds: [] })).rejects.toThrow(/non autorisé/i);
  });
});

describe("channel administration", () => {
  it("creates an OFFLINE channel mapped to active locations, and requires channels.manage", async () => {
    const wh = await prisma.warehouse.create({ data: { name: "Boutique Rabat", type: "MAGASIN" } });
    await loginAsTestUser({ role: "MANAGER" });
    await expect(createSalesChannelAction({ name: "Magasin Rabat", kind: "OFFLINE", warehouseIds: [wh.id] })).rejects.toThrow(
      /non autorisé/i
    );

    mockCookieStore.clear();
    await loginAsTestUser({ role: "ADMIN" });
    const r = await createSalesChannelAction({ name: "Magasin Rabat", kind: "OFFLINE", warehouseIds: [wh.id] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const locs = await prisma.salesChannelLocation.findMany({ where: { salesChannelId: r.data.id } });
    expect(locs.map((l) => l.warehouseId)).toEqual([wh.id]);
  });

  it("rejects a duplicate name, an inactive/foreign location, and retiring the default ONLINE channel", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const online = await ensureDefaultOnlineChannel();
    const gone = await prisma.warehouse.create({ data: { name: "Fermé", isActive: false } });

    expect((await createSalesChannelAction({ name: online.name, kind: "OFFLINE", warehouseIds: [] })).ok).toBe(false);
    expect((await createSalesChannelAction({ name: "Nouveau", kind: "OFFLINE", warehouseIds: [gone.id] })).ok).toBe(false);
    expect((await updateSalesChannelAction({ id: online.id, name: online.name, isActive: false })).ok).toBe(false);
    expect((await setChannelLocationsAction({ id: online.id, warehouseIds: [gone.id] })).ok).toBe(false);
  });

  it("remapping a channel's locations moves NO stock", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const wh = await prisma.warehouse.create({ data: { name: "Dépôt", isDefault: true } });
    const product = await prisma.product.create({ data: { name: "P", sku: "P-MAP", price: 1 } });
    const item = await prisma.inventoryItem.create({ data: { warehouseId: wh.id, productId: product.id, quantityOnHand: 7 } });
    const store = await makeStore();

    await setChannelLocationsAction({ id: store.id, warehouseIds: [wh.id] });
    await setChannelLocationsAction({ id: store.id, warehouseIds: [] });

    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantityOnHand).toBe(7);
    expect(await prisma.inventoryMovement.count()).toBe(0);
  });
});
