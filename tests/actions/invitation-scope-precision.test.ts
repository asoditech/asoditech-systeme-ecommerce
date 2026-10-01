import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { ROLE_PERMISSIONS } from "@/lib/auth/permissions";
import { getCurrentUser } from "@/lib/auth/session";
import { inviteUserAction, acceptInvitationAction, listInvitationScopeOptionsAction } from "@/actions/invitations";
import { createSaleAction, createSaleReturnAction } from "@/actions/sales";
import { listSales } from "@/lib/queries/sales";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser, ensureDefaultOnlineChannelFor } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { RedirectSignal } from "../setup";

/**
 * Invite-time channel/location precision (docs/adr/0047).
 */

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  await setTestBusinessMode("ONLINE_AND_OFFLINE");
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

/** Two stores, each its own OFFLINE channel + MAGASIN location, one product stocked in both. */
async function seedTwoStores() {
  const mk = async (tag: string) => {
    const wh = await prisma.warehouse.create({ data: { name: `Magasin ${tag}`, type: "MAGASIN" } });
    const ch = await prisma.salesChannel.create({ data: { name: `Boutique ${tag}`, kind: "OFFLINE" } });
    await prisma.salesChannelLocation.create({ data: { salesChannelId: ch.id, warehouseId: wh.id } });
    return { wh, ch };
  };
  const a = await mk("A");
  const b = await mk("B");
  const product = await prisma.product.create({ data: { name: "Basket", sku: "BSK-47", price: 250, status: "ACTIF", cost: 100 } });
  for (const s of [a, b]) {
    await prisma.productSalesChannel.create({ data: { productId: product.id, salesChannelId: s.ch.id } });
    await prisma.inventoryItem.create({ data: { warehouseId: s.wh.id, productId: product.id, quantityOnHand: 10 } });
  }
  return { a, b, product };
}

function inviteForm(fields: Record<string, string | string[]>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => fd.append(k, x));
    else fd.set(k, v);
  }
  return fd;
}

async function accept(inviteUrl: string) {
  mockCookieStore.clear();
  const fd = new FormData();
  fd.set("token", inviteUrl.replace("/invitations/", ""));
  fd.set("password", "correct-horse-battery-staple");
  await expect(acceptInvitationAction(undefined, fd)).rejects.toThrow(RedirectSignal);
  return prismaBase.user.findFirstOrThrow({ where: { email: { contains: "@" } }, orderBy: { createdAt: "desc" } });
}

const sale = (channelId: string, warehouseId: string, productId: string) => ({
  salesChannelId: channelId,
  warehouseId,
  idempotencyKey: randomUUID(),
  lines: [{ productId, quantity: 1 }],
  payments: [{ method: "ESPECES" as const, amount: 250 }],
});

describe("STORE_SELLER invited to Store A only", () => {
  it("is scoped to Store A at acceptance: one channel, one location, seller permissions exactly, no Online", async () => {
    const { a, b, product } = await seedTwoStores();
    await loginAsTestUser({ role: "ADMIN" });
    // a Store-B sale that must stay invisible to the new seller
    expect((await createSaleAction(sale(b.ch.id, b.wh.id, product.id))).ok).toBe(true);

    const inv = await inviteUserAction(
      inviteForm({ name: "Vendeuse A", email: "vendeuse-a@test.local", role: "STORE_SELLER", channelScope: "OFFLINE", offlineChannelIds: [a.ch.id], warehouseIds: [a.wh.id] })
    );
    expect(inv.ok).toBe(true);
    if (!inv.ok) return;
    const stored = await prisma.invitation.findUniqueOrThrow({ where: { id: inv.data.id } });
    expect(stored.offlineChannelIds).toEqual([a.ch.id]);
    expect(stored.warehouseIds).toEqual([a.wh.id]);

    const seller = await accept(inv.data.inviteUrl);
    expect(seller.email).toBe("vendeuse-a@test.local");
    expect((await prismaBase.userChannel.findMany({ where: { userId: seller.id } })).map((c) => c.salesChannelId)).toEqual([a.ch.id]);
    expect((await prismaBase.userLocation.findMany({ where: { userId: seller.id } })).map((l) => l.warehouseId)).toEqual([a.wh.id]);

    const me = (await getCurrentUser())!;
    expect(me.id).toBe(seller.id);
    expect([...me.permissions].sort()).toEqual([...ROLE_PERMISSIONS.STORE_SELLER].sort());
    expect(me.channels.online).toBe(false);
    expect(me.channels.offlineIds).toEqual([a.ch.id]);

    // sells in Store A immediately — no admin follow-up needed
    const own = await createSaleAction(sale(a.ch.id, a.wh.id, product.id));
    expect(own.ok).toBe(true);
    // Store B: neither its channel, nor its location, nor Store A's channel on Store B's location
    await expect(createSaleAction(sale(b.ch.id, b.wh.id, product.id))).rejects.toThrow(/non autorisé/i);
    const crossed = await createSaleAction(sale(a.ch.id, b.wh.id, product.id)).catch((e: Error) => ({ ok: false as const, error: e.message }));
    expect(crossed.ok).toBe(false);
    // and cannot see Store B's sales
    const visible = await listSales(me);
    expect(visible.sales.every((s) => s.salesChannelId === a.ch.id)).toBe(true);
    expect(visible.total).toBe(1);
    // nor return one
    const bSale = await prisma.sale.findFirstOrThrow({ where: { salesChannelId: b.ch.id } });
    const bLine = await prisma.saleLine.findFirstOrThrow({ where: { saleId: bSale.id } });
    const ret = await createSaleReturnAction({ saleId: bSale.id, idempotencyKey: randomUUID(), lines: [{ saleLineId: bLine.id, quantitySellable: 1, quantityDamaged: 0 }] });
    expect(ret.ok).toBe(false);
    expect((await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: b.wh.id } })).quantityOnHand).toBe(9);
  });

  it("a channel retired between invitation and acceptance is dropped — never widened to every store channel", async () => {
    const { a } = await seedTwoStores();
    await loginAsTestUser({ role: "ADMIN" });
    const inv = await inviteUserAction(
      inviteForm({ name: "Vendeuse", email: "v-retired@test.local", role: "STORE_SELLER", channelScope: "OFFLINE", offlineChannelIds: [a.ch.id], warehouseIds: [a.wh.id] })
    );
    if (!inv.ok) throw new Error(inv.error);
    await prisma.salesChannel.update({ where: { id: a.ch.id }, data: { isActive: false } });
    await prisma.warehouse.update({ where: { id: a.wh.id }, data: { isActive: false } });
    const seller = await accept(inv.data.inviteUrl);
    expect(await prismaBase.userChannel.count({ where: { userId: seller.id } })).toBe(0);
    expect(await prismaBase.userLocation.count({ where: { userId: seller.id } })).toBe(0);
  });
});

describe("validation at invitation time", () => {
  it("rejects unknown, inactive, ONLINE or foreign-tenant ids, and store channels without a store scope", async () => {
    const { a } = await seedTwoStores();
    const online = await ensureDefaultOnlineChannelFor();
    const retired = await prisma.salesChannel.create({ data: { name: "Fermé", kind: "OFFLINE", isActive: false } });
    await prismaBase.tenant.create({ data: { id: "tenant-b-0047", name: "B", slug: "tenant-b-0047" } });
    const foreignCh = await prismaBase.salesChannel.create({ data: { name: "Autre", kind: "OFFLINE", tenantId: "tenant-b-0047" } });
    const foreignWh = await prismaBase.warehouse.create({ data: { name: "Autre", tenantId: "tenant-b-0047" } });
    await loginAsTestUser({ role: "ADMIN" });
    const base = { name: "Xavier", role: "STORE_SELLER", channelScope: "OFFLINE" };
    const cases: [Record<string, string | string[]>, RegExp][] = [
      [{ ...base, email: "c1@test.local", offlineChannelIds: ["nope"] }, /canal magasin/i],
      [{ ...base, email: "c2@test.local", offlineChannelIds: [retired.id] }, /canal magasin/i],
      [{ ...base, email: "c3@test.local", offlineChannelIds: [online.id] }, /canal magasin/i],
      [{ ...base, email: "c4@test.local", offlineChannelIds: [foreignCh.id] }, /canal magasin/i],
      [{ ...base, email: "c5@test.local", warehouseIds: [foreignWh.id] }, /emplacement/i],
      [{ name: "Xavier", role: "MANAGER", channelScope: "ONLINE", email: "c6@test.local", offlineChannelIds: [a.ch.id] }, /portée/i],
    ];
    for (const [fields, err] of cases) {
      const r = await inviteUserAction(inviteForm(fields));
      expect(r.ok, fields.email as string).toBe(false);
      if (!r.ok) expect(r.error).toMatch(err);
    }
    expect(await prisma.invitation.count()).toBe(0);
  });

  it("a global role's ids are dropped (it needs no rows), exactly like its channel scope", async () => {
    const { a } = await seedTwoStores();
    await loginAsTestUser({ role: "OWNER" });
    const inv = await inviteUserAction(inviteForm({ name: "Admin", email: "adm@test.local", role: "ADMIN", channelScope: "OFFLINE", offlineChannelIds: [a.ch.id], warehouseIds: [a.wh.id] }));
    if (!inv.ok) throw new Error(inv.error);
    const stored = await prisma.invitation.findUniqueOrThrow({ where: { id: inv.data.id } });
    expect(stored).toMatchObject({ channelScope: null, offlineChannelIds: [], warehouseIds: [] });
    const admin = await accept(inv.data.inviteUrl);
    expect(await prismaBase.userChannel.count({ where: { userId: admin.id } })).toBe(0);
    expect(await prismaBase.userLocation.count({ where: { userId: admin.id } })).toBe(0);
  });

  it("only users.manage may invite or list the options", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    await expect(listInvitationScopeOptionsAction()).rejects.toThrow(/non autorisé/i);
    await expect(inviteUserAction(inviteForm({ name: "Xavier", email: "x@test.local", role: "STORE_SELLER" }))).rejects.toThrow(/non autorisé/i);
  });
});

describe("backward compatibility", () => {
  it("no ids → legacy behaviour unchanged: OFFLINE = every active store channel, no location", async () => {
    await seedTwoStores();
    await loginAsTestUser({ role: "ADMIN" });
    const inv = await inviteUserAction(inviteForm({ name: "Legacy", email: "legacy@test.local", role: "STORE_SELLER", channelScope: "OFFLINE" }));
    if (!inv.ok) throw new Error(inv.error);
    const user = await accept(inv.data.inviteUrl);
    expect(await prismaBase.userChannel.count({ where: { userId: user.id } })).toBe(2);
    expect(await prismaBase.userLocation.count({ where: { userId: user.id } })).toBe(0);
  });

  it("an invitation created before this change (empty columns) is accepted exactly as before", async () => {
    await seedTwoStores();
    await loginAsTestUser({ role: "ADMIN" });
    const inv = await inviteUserAction(inviteForm({ name: "Old", email: "old@test.local", role: "CONFIRMATION" }));
    if (!inv.ok) throw new Error(inv.error);
    // simulate a pre-migration row: the defaults ARE the legacy state
    expect(await prisma.invitation.findUniqueOrThrow({ where: { id: inv.data.id } })).toMatchObject({ offlineChannelIds: [], warehouseIds: [], channelScope: null });
    const user = await accept(inv.data.inviteUrl);
    const channels = await prismaBase.userChannel.findMany({ where: { userId: user.id }, include: { salesChannel: true } });
    expect(channels.map((c) => c.salesChannel.kind)).toEqual(["ONLINE"]);
  });

  it("a MANAGER can be invited Store-scoped with locations (the store-manager setup), Online manager unchanged", async () => {
    const { a, b } = await seedTwoStores();
    await loginAsTestUser({ role: "ADMIN" });
    const inv = await inviteUserAction(
      inviteForm({ name: "Resp. A", email: "resp-a@test.local", role: "MANAGER", channelScope: "OFFLINE", offlineChannelIds: [a.ch.id], warehouseIds: [a.wh.id] })
    );
    if (!inv.ok) throw new Error(inv.error);
    const mgr = await accept(inv.data.inviteUrl);
    const me = (await getCurrentUser())!;
    expect(me.id).toBe(mgr.id);
    expect(me.channels.online).toBe(false);
    expect(me.channels.offlineIds).toEqual([a.ch.id]);
    expect(me.permissions.has("orders.view")).toBe(false); // Online permissions removed by scope
    expect(me.permissions.has("sales.create")).toBe(true);
    expect((await prismaBase.userLocation.findMany({ where: { userId: mgr.id } })).map((l) => l.warehouseId)).toEqual([a.wh.id]);
    expect(b).toBeDefined();

    mockCookieStore.clear();
    await loginAsTestUser({ role: "ADMIN" });
    const online = await inviteUserAction(inviteForm({ name: "Resp. web", email: "web@test.local", role: "MANAGER", channelScope: "ONLINE" }));
    if (!online.ok) throw new Error(online.error);
    const web = await accept(online.data.inviteUrl);
    expect(await prismaBase.userLocation.count({ where: { userId: web.id } })).toBe(0);
    expect((await getCurrentUser())!.permissions.has("orders.view")).toBe(true);
  });

  it("the options list: active store channels with their locations, and active locations", async () => {
    const { a, b } = await seedTwoStores();
    await prisma.salesChannel.create({ data: { name: "Fermé", kind: "OFFLINE", isActive: false } });
    await loginAsTestUser({ role: "ADMIN" });
    const o = await listInvitationScopeOptionsAction();
    expect(o.offlineChannels.map((c) => c.name).sort()).toEqual(["Boutique A", "Boutique B"]);
    expect(o.offlineChannels.find((c) => c.id === a.ch.id)!.warehouseIds).toEqual([a.wh.id]);
    expect(o.warehouses.map((w) => w.id)).toEqual(expect.arrayContaining([a.wh.id, b.wh.id]));

    await setTestBusinessMode("ONLINE_ONLY");
    expect((await listInvitationScopeOptionsAction()).offlineChannels).toEqual([]);
  });
});
