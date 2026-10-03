import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Critical notification emails — docs/adr/0057. The transport
 * (`sendNotificationEmails`) is mocked: these tests check WHO is emailed,
 * WHEN, and that the in-app behaviour is untouched. The Resend transport
 * itself is covered by tests/lib/email-transport.test.ts.
 */

const { sendNotificationEmails } = vi.hoisted(() => ({ sendNotificationEmails: vi.fn(async () => {}) }));
vi.mock("@/lib/email", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/email")>()), sendNotificationEmails }));

import { prisma, prismaBase } from "@/lib/prisma";
import { checkAndNotifyLowStock, notifyConnectionError, notifyShipmentFailed } from "@/lib/notifications";
import { checkAndNotifyUsageThreshold } from "@/lib/entitlements/alerts";
import { adjustInventoryAction } from "@/actions/inventory";
import { runWithTenant } from "@/lib/tenant/context";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";
import { createTestUser, grantLocationAccess, loginAsTestUser } from "../helpers/auth";

beforeEach(async () => {
  await resetDb();
  sendNotificationEmails.mockClear();
  sendNotificationEmails.mockImplementation(async () => {});
});
afterEach(async () => {
  await resetDb();
});

type Sent = { to: string; email: { subject: string; title: string; message: string; path: string } };
/** Every email handed to the transport, flattened. */
function sent(): Sent[] {
  return sendNotificationEmails.mock.calls.flatMap((c) => (c as unknown as [Sent[]])[0]);
}
const recipients = () => sent().map((m) => m.to).sort();

async function world() {
  const whA = await prisma.warehouse.create({ data: { name: "Magasin A", type: "MAGASIN" } });
  const whB = await prisma.warehouse.create({ data: { name: "Magasin B", type: "MAGASIN" } });
  const product = await prisma.product.create({ data: { name: "Sac", sku: "MAIL-1", price: 100, status: "ACTIF", trackInventory: true, lowStockThreshold: 5 } });
  const itemA = await prisma.inventoryItem.create({ data: { warehouseId: whA.id, productId: product.id, quantityOnHand: 0 } }); // out
  const itemB = await prisma.inventoryItem.create({ data: { warehouseId: whB.id, productId: product.id, quantityOnHand: 3 } }); // low only
  const user = async (role: "OWNER" | "ADMIN" | "MANAGER" | "WAREHOUSE" | "CONFIRMATION", locations: string[], status: "ACTIVE" | "DISABLED" = "ACTIVE") => {
    const u = await createTestUser({ role, status });
    if (locations.length) await grantLocationAccess(u.id, locations);
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
    storeA: await user("WAREHOUSE", [whA.id]),
    storeB: await user("WAREHOUSE", [whB.id]),
    noPermissionA: await user("CONFIRMATION", [whA.id]),
    disabledA: await user("WAREHOUSE", [whA.id], "DISABLED"),
  };
}

describe("out of stock (location-bound)", () => {
  it("emails exactly the in-app recipients of the affected location: eligible store user + Owner/Admin; never Store B, inactive, or unpermitted", async () => {
    const w = await world();
    await checkAndNotifyLowStock({ productIds: [w.product.id] });

    // Only Store A's item is OUT of stock; Store B's is merely low (in-app only).
    expect(recipients()).toEqual([w.owner.email, w.admin.email, w.storeA.email].sort());
    expect(sent().every((m) => m.email.title === "Rupture de stock")).toBe(true);
    expect(sent()[0].email.message).toContain("Magasin A");
    expect(sent()[0].email.path).toBe("/stock");

    // In-app unchanged: Store B still gets its low-stock bell entry, no email.
    const storeB = await prismaBase.notification.findMany({ where: { userId: w.storeB.id }, select: { type: true } });
    expect(storeB.map((n) => n.type)).toEqual(["STOCK_FAIBLE"]);
    const ruptureRecipients = await prismaBase.notification.findMany({ where: { type: "RUPTURE_STOCK" }, select: { userId: true } });
    expect(ruptureRecipients.map((r) => r.userId).sort()).toEqual([w.owner.id, w.admin.id, w.storeA.id].sort());
  });

  it("low stock alone never emails", async () => {
    const w = await world();
    await prisma.inventoryItem.update({ where: { id: w.itemA.id }, data: { quantityOnHand: 4 } });
    await checkAndNotifyLowStock({ productIds: [w.product.id] });
    expect(sent()).toEqual([]);
    expect(await prismaBase.notification.count({ where: { type: "STOCK_FAIBLE" } })).toBeGreaterThan(0);
  });

  it("processing the same event twice (or concurrently) sends each email once", async () => {
    const w = await world();
    await checkAndNotifyLowStock({ productIds: [w.product.id] });
    await checkAndNotifyLowStock({ productIds: [w.product.id] });
    await Promise.all([checkAndNotifyLowStock({ productIds: [w.product.id] }), checkAndNotifyLowStock({ productIds: [w.product.id] })]);
    expect(recipients()).toEqual([w.owner.email, w.admin.email, w.storeA.email].sort());
  });

  it("a tenant's event never emails another tenant's users", async () => {
    const w = await world();
    await prismaBase.tenant.create({ data: { id: "tenant-b-0057", name: "B", slug: "tenant-b-0057" } });
    const bOwner = await createTestUser({ role: "OWNER", tenantId: "tenant-b-0057" });
    await runWithTenant(DEFAULT_TENANT_ID, "test", () => checkAndNotifyLowStock({ productIds: [w.product.id] }));
    expect(recipients()).not.toContain(bOwner.email);
    expect(recipients()).toEqual([w.owner.email, w.admin.email, w.storeA.email].sort());
  });

  it("an email transport failure never breaks the stock adjustment that triggered it", async () => {
    const w = await world();
    sendNotificationEmails.mockImplementation(async () => {
      throw new Error("Resend down");
    });
    const actor = await loginAsTestUser({ role: "WAREHOUSE" });
    await grantLocationAccess(actor.id, w.whB.id);
    const result = await adjustInventoryAction(
      (() => {
        const f = new FormData();
        for (const [k, v] of Object.entries({ productId: w.product.id, warehouseId: w.whB.id, type: "AJUSTEMENT_NEGATIF", quantity: "3", reason: "Casse" })) f.set(k, v);
        return f;
      })()
    );
    expect(result.ok).toBe(true);
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: w.itemB.id } })).quantityOnHand).toBe(0);
    expect(sendNotificationEmails).toHaveBeenCalled(); // it was attempted…
    expect(await prismaBase.notification.count({ where: { type: "RUPTURE_STOCK", entityId: w.itemB.id } })).toBeGreaterThan(0); // …and the in-app alert stands
  });
});

describe("events without a location (tenant + active + permission, unchanged)", () => {
  it("delivery failure emails every active delivery.view holder regardless of location, never the customer, never the actor", async () => {
    const w = await world();
    const customer = await prisma.customer.create({ data: { fullName: "Client", email: "buyer@example.com" } });
    const order = await prisma.order.create({ data: { customerId: customer.id, subtotal: 10, total: 10 } });
    const input = { id: "shp-1", orderId: order.id, orderNumber: order.orderNumber, providerName: "Transporteur X", reason: null };
    await notifyShipmentFailed(input, w.admin.id);
    await notifyShipmentFailed(input, w.admin.id); // reprocessed: no second email

    expect(recipients()).toEqual([w.owner.email, w.storeA.email, w.storeB.email].sort());
    expect(recipients()).not.toContain("buyer@example.com");
    expect(sent()[0].email.title).toBe("Échec de livraison");
    expect(sent()[0].email.message).toBe("Une ou plusieurs livraisons nécessitent votre attention.");
  });

  it("integration error emails integrations.view holders only (permission still required)", async () => {
    const w = await world();
    await notifyConnectionError({ entityType: "Integration", entityId: "int-1", label: "WooCommerce", recipientPermission: "integrations.view" });
    expect(recipients()).toEqual([w.owner.email, w.admin.email].sort());
    expect(sent()[0].email.title).toBe("Erreur d'intégration");
    expect(sent()[0].email.path).toBe("/integrations");
  });

  it("plan limit emails at 100% only; 80/90% stay in-app", async () => {
    const w = await world();
    await checkAndNotifyUsageThreshold(DEFAULT_TENANT_ID, "ORDERS", { used: 90, limit: 100, percent: 90, status: "CRITICAL" });
    expect(sent()).toEqual([]);
    expect(await prismaBase.notification.count({ where: { type: "USAGE_LIMIT_ALERT" } })).toBe(2);

    await checkAndNotifyUsageThreshold(DEFAULT_TENANT_ID, "ORDERS", { used: 100, limit: 100, percent: 100, status: "LIMIT_REACHED" });
    await checkAndNotifyUsageThreshold(DEFAULT_TENANT_ID, "ORDERS", { used: 101, limit: 100, percent: 101, status: "LIMIT_REACHED" });
    expect(recipients()).toEqual([w.owner.email, w.admin.email].sort());
    expect(sent()[0].email.title).toBe("Limite du forfait atteinte");
  });
});

describe("non-critical events never email", () => {
  it("new order, payment problem and workflow events stay in-app", async () => {
    await world();
    const { notifyNewOrder, notifyPaymentProblem } = await import("@/lib/notifications");
    await notifyNewOrder({ id: "o1", orderNumber: 1, total: 10, currency: "MAD", customerName: "Client", source: "INTERNE" });
    await notifyPaymentProblem({ id: "o1", orderNumber: 1 });
    expect(sent()).toEqual([]);
    expect(await prismaBase.notification.count({ where: { type: "NOUVELLE_COMMANDE" } })).toBeGreaterThan(0);
  });
});
