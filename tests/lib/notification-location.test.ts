import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { checkAndNotifyLowStock, notify, notifyNewOrder } from "@/lib/notifications";
import { runWithTenant } from "@/lib/tenant/context";
import { resetDb } from "../helpers/db";
import { createTestUser, grantLocationAccess } from "../helpers/auth";

/**
 * Location-scoped in-app notifications — docs/adr/0056. A location-bound
 * event (one stock item = one location) reaches only users who may read
 * that location; everything else is unchanged.
 */

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

async function world() {
  const whA = await prisma.warehouse.create({ data: { name: "Magasin A", type: "MAGASIN" } });
  const whB = await prisma.warehouse.create({ data: { name: "Magasin B", type: "MAGASIN" } });
  const product = await prisma.product.create({ data: { name: "Sac", sku: "LOC-1", price: 100, status: "ACTIF", trackInventory: true, lowStockThreshold: 5 } });
  const itemA = await prisma.inventoryItem.create({ data: { warehouseId: whA.id, productId: product.id, quantityOnHand: 2 } }); // low
  const itemB = await prisma.inventoryItem.create({ data: { warehouseId: whB.id, productId: product.id, quantityOnHand: 0 } }); // out
  const user = async (role: "OWNER" | "ADMIN" | "MANAGER" | "WAREHOUSE" | "CONFIRMATION", locations: { id: string }[], status: "ACTIVE" | "DISABLED" = "ACTIVE") => {
    const u = await createTestUser({ role, status });
    if (locations.length) await grantLocationAccess(u.id, locations.map((l) => l.id));
    return u;
  };
  return {
    whA,
    whB,
    product,
    itemA,
    itemB,
    owner: await user("OWNER", []),
    admin: await user("ADMIN", []),
    storeA: await user("WAREHOUSE", [whA]),
    storeB: await user("WAREHOUSE", [whB]),
    both: await user("MANAGER", [whA, whB]),
    noLocation: await user("MANAGER", []),
    noPermissionA: await user("CONFIRMATION", [whA]), // no inventory.view
    disabledA: await user("WAREHOUSE", [whA], "DISABLED"),
  };
}

/** userId → sorted list of the stock items they were notified about. */
async function stockInbox() {
  const rows = await prismaBase.notification.findMany({ where: { type: { in: ["STOCK_FAIBLE", "RUPTURE_STOCK"] } }, select: { userId: true, entityId: true } });
  const m = new Map<string, string[]>();
  for (const r of rows) m.set(r.userId, [...(m.get(r.userId) ?? []), r.entityId!].sort());
  return m;
}

describe("location-bound stock notifications", () => {
  it("each recipient gets exactly the locations they may read (1, 2, 3, 4, 7, 10)", async () => {
    const w = await world();
    await checkAndNotifyLowStock({ productIds: [w.product.id] });
    const inbox = await stockInbox();
    const both = [w.itemA.id, w.itemB.id].sort();
    expect(inbox.get(w.storeA.id)).toEqual([w.itemA.id]); // 1 + 2
    expect(inbox.get(w.storeB.id)).toEqual([w.itemB.id]); // 3
    expect(inbox.get(w.owner.id)).toEqual(both); // 4: OWNER/ADMIN unchanged — every location
    expect(inbox.get(w.admin.id)).toEqual(both);
    expect(inbox.get(w.both.id)).toEqual(both); // 10: multi-location user
    expect(inbox.has(w.noLocation.id)).toBe(false); // zero locations = none (ADR 0050)
    expect(inbox.has(w.noPermissionA.id)).toBe(false); // 7: permission still required
    expect(inbox.has(w.disabledA.id)).toBe(false); // active users only
    const types = await prismaBase.notification.findMany({ where: { userId: w.storeB.id }, select: { type: true } });
    expect(types.map((t) => t.type)).toEqual(["RUPTURE_STOCK"]);
  });

  it("dedupe (8) and the low-stock daily bucket (9) still hold per user", async () => {
    const w = await world();
    await checkAndNotifyLowStock({ productIds: [w.product.id] });
    await checkAndNotifyLowStock({ productIds: [w.product.id] });
    const inbox = await stockInbox();
    expect(inbox.get(w.storeA.id)).toEqual([w.itemA.id]);
    expect(inbox.get(w.owner.id)).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      await notify({
        type: "STOCK_FAIBLE",
        title: "t",
        message: "m",
        entityType: "InventoryItem",
        entityId: w.itemA.id,
        dedupeKey: "manual:dedupe",
        recipientPermission: "inventory.view",
        warehouseId: w.whA.id,
      });
    }
    expect(await prismaBase.notification.count({ where: { dedupeKey: "manual:dedupe" } })).toBe(4); // owner, admin, storeA, both — once each
  });

  it("recovered stock clears the alert for the users who had it", async () => {
    const w = await world();
    await checkAndNotifyLowStock({ productIds: [w.product.id] });
    await prisma.inventoryItem.update({ where: { id: w.itemA.id }, data: { quantityOnHand: 50 } });
    await checkAndNotifyLowStock({ productIds: [w.product.id] });
    expect((await stockInbox()).get(w.storeA.id)).toBeUndefined();
  });
});

describe("unchanged behaviour", () => {
  it("a non-location-bound event still reaches every permitted user, assigned to a location or not (6)", async () => {
    const w = await world();
    const customer = await prisma.customer.create({ data: { fullName: "Client" } });
    const order = await prisma.order.create({ data: { customerId: customer.id, subtotal: 10, total: 10 } });
    await notifyNewOrder({ id: order.id, orderNumber: order.orderNumber, total: 10, currency: "MAD", customerName: "Client", source: order.source });
    const got = (await prismaBase.notification.findMany({ where: { type: "NOUVELLE_COMMANDE" }, select: { userId: true } })).map((n) => n.userId).sort();
    // orders.view holders: OWNER, ADMIN, MANAGER×2, WAREHOUSE×2, CONFIRMATION (active only)
    expect(got).toEqual([w.owner.id, w.admin.id, w.storeA.id, w.storeB.id, w.both.id, w.noLocation.id, w.noPermissionA.id].sort());
  });

  it("tenant A's location event never reaches tenant B (5)", async () => {
    const w = await world();
    await prismaBase.tenant.create({ data: { id: "tenant-b-0056", name: "B", slug: "tenant-b-0056" } });
    const bOwner = await createTestUser({ role: "OWNER", tenantId: "tenant-b-0056" });
    const bWh = await prismaBase.warehouse.create({ data: { tenantId: "tenant-b-0056", name: "B entrepôt" } });
    const bUser = await createTestUser({ role: "WAREHOUSE", tenantId: "tenant-b-0056" });
    await grantLocationAccess(bUser.id, bWh.id);
    await runWithTenant("default", "test", () => checkAndNotifyLowStock({ productIds: [w.product.id] }));
    expect(await prismaBase.notification.count({ where: { userId: { in: [bOwner.id, bUser.id] } } })).toBe(0);
    // and a tenant-B event whose warehouse id is tenant A's reaches nobody in A
    await runWithTenant("tenant-b-0056", "test", () =>
      notify({ type: "STOCK_FAIBLE", title: "t", message: "m", recipientPermission: "inventory.view", warehouseId: w.whA.id, dedupeKey: "cross" })
    );
    const cross = await prismaBase.notification.findMany({ where: { dedupeKey: "cross" }, select: { userId: true, tenantId: true } });
    expect(cross.every((n) => n.tenantId === "tenant-b-0056")).toBe(true);
    expect(cross.map((n) => n.userId)).toEqual([bOwner.id]); // B's owner (global) only; B's location user is not assigned to A's id
  });
});
