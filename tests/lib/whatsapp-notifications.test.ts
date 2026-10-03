import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WhatsApp critical notifications V1 — docs/adr/0058. The Meta provider is
 * mocked (no network); these tests check WHO gets WHICH template, WHEN.
 */

const meta = vi.hoisted(() => ({
  configured: true,
  sendTemplateMessage: vi.fn<(to: string, message: unknown) => Promise<{ ok: boolean; messageId?: string; error?: string }>>(async () => ({ ok: true, messageId: "wamid.test" })),
}));
vi.mock("@/lib/whatsapp/client", () => ({
  isWhatsAppConfigured: () => meta.configured,
  sendTemplateMessage: meta.sendTemplateMessage,
  sendTemplate: vi.fn(),
  checkWhatsAppSender: vi.fn(),
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendNotificationEmails: vi.fn(async () => {}),
}));

import { prisma, prismaBase } from "@/lib/prisma";
import {
  checkAndNotifyLowStock,
  notifyConnectionError,
  notifyNewOrder,
  notifyPaymentProblem,
  notifyShipmentsFailed,
} from "@/lib/notifications";
import { checkAndNotifyUsageThreshold } from "@/lib/entitlements/alerts";
import { adjustInventoryAction } from "@/actions/inventory";
import { runWithTenant } from "@/lib/tenant/context";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";
import { createTestUser, grantLocationAccess, loginAsTestUser } from "../helpers/auth";

type Sent = { to: string; templateName: string; parameters: string[] };
function sent(): Sent[] {
  return meta.sendTemplateMessage.mock.calls.map((c) => {
    const [to, m] = c as [string, { templateName: string; parameters: string[] }];
    return { to, templateName: m.templateName, parameters: m.parameters };
  });
}
const sentTo = (template?: string) =>
  sent()
    .filter((s) => !template || s.templateName === template)
    .map((s) => s.to)
    .sort();

let phoneSeq = 0;
/** Verified + opted-in, unless told otherwise. Returns the user's WhatsApp digits. */
async function setWhatsApp(userId: string, state: { verified?: boolean; optIn?: boolean } = {}) {
  phoneSeq += 1;
  const phone = `2126${String(10_000_000 + phoneSeq).slice(-8)}`;
  await prismaBase.user.update({
    where: { id: userId },
    data: {
      whatsappPhone: phone,
      whatsappVerifiedAt: state.verified === false ? null : new Date(),
      whatsappOptInAt: state.optIn === false ? null : new Date(),
    },
  });
  return phone;
}

beforeEach(async () => {
  await resetDb();
  meta.configured = true;
  meta.sendTemplateMessage.mockReset();
  meta.sendTemplateMessage.mockImplementation(async () => ({ ok: true as const, messageId: "wamid.test" }));
});
afterEach(async () => {
  await resetDb();
});

async function world() {
  await prisma.integration.create({ data: { provider: "WHATSAPP", status: "CONNECTE" } });
  const whA = await prisma.warehouse.create({ data: { name: "Magasin A", type: "MAGASIN" } });
  const whB = await prisma.warehouse.create({ data: { name: "Magasin B", type: "MAGASIN" } });
  const product = await prisma.product.create({ data: { name: "Sac Cuir", sku: "WA-1", price: 100, status: "ACTIF", trackInventory: true, lowStockThreshold: 5 } });
  const itemA = await prisma.inventoryItem.create({ data: { warehouseId: whA.id, productId: product.id, quantityOnHand: 0 } }); // out
  const itemB = await prisma.inventoryItem.create({ data: { warehouseId: whB.id, productId: product.id, quantityOnHand: 3 } }); // low only
  const user = async (role: "OWNER" | "ADMIN" | "WAREHOUSE" | "CONFIRMATION", locations: string[], status: "ACTIVE" | "DISABLED" = "ACTIVE") => {
    const u = await createTestUser({ role, status });
    if (locations.length) await grantLocationAccess(u.id, locations);
    return u;
  };
  const owner = await user("OWNER", []);
  const admin = await user("ADMIN", []);
  const storeA = await user("WAREHOUSE", [whA.id]);
  const storeB = await user("WAREHOUSE", [whB.id]);
  const unverifiedA = await user("WAREHOUSE", [whA.id]);
  const optedOutA = await user("WAREHOUSE", [whA.id]);
  const noPermissionA = await user("CONFIRMATION", [whA.id]);
  const disabledA = await user("WAREHOUSE", [whA.id], "DISABLED");
  const phone = {
    owner: await setWhatsApp(owner.id),
    admin: await setWhatsApp(admin.id),
    storeA: await setWhatsApp(storeA.id),
    storeB: await setWhatsApp(storeB.id),
    unverifiedA: await setWhatsApp(unverifiedA.id, { verified: false, optIn: false }),
    optedOutA: await setWhatsApp(optedOutA.id, { optIn: false }),
    noPermissionA: await setWhatsApp(noPermissionA.id),
    disabledA: await setWhatsApp(disabledA.id),
  };
  return { whA, whB, product, itemA, itemB, owner, admin, storeA, storeB, phone };
}

describe("out of stock (location-bound)", () => {
  it("sends asoditech_stock_out only to verified, opted-in, permitted, active users of that location (+ Owner/Admin)", async () => {
    const w = await world();
    await checkAndNotifyLowStock({ productIds: [w.product.id] });
    expect(sentTo()).toEqual([w.phone.owner, w.phone.admin, w.phone.storeA].sort());
    expect(sent().every((s) => s.templateName === "asoditech_stock_out")).toBe(true);
    expect(sent()[0].parameters).toEqual(["Sac Cuir", "Magasin A"]);
    // Never: Store B (other location, and its item is only LOW), unverified,
    // opted out, no permission, disabled.
    for (const p of [w.phone.storeB, w.phone.unverifiedA, w.phone.optedOutA, w.phone.noPermissionA, w.phone.disabledA]) {
      expect(sentTo()).not.toContain(p);
    }
  });

  it("reprocessed or concurrent events never send twice", async () => {
    const w = await world();
    await checkAndNotifyLowStock({ productIds: [w.product.id] });
    await checkAndNotifyLowStock({ productIds: [w.product.id] });
    await Promise.all([checkAndNotifyLowStock({ productIds: [w.product.id] }), checkAndNotifyLowStock({ productIds: [w.product.id] })]);
    expect(sentTo()).toEqual([w.phone.owner, w.phone.admin, w.phone.storeA].sort());
  });

  it("nothing is sent when the tenant has not enabled WhatsApp", async () => {
    const w = await world();
    await prisma.integration.updateMany({ where: { provider: "WHATSAPP" }, data: { status: "DECONNECTE" } });
    await checkAndNotifyLowStock({ productIds: [w.product.id] });
    expect(sent()).toEqual([]);
    expect(await prismaBase.notification.count({ where: { type: "RUPTURE_STOCK" } })).toBeGreaterThan(0); // in-app unchanged
  });

  it("nothing is sent when the central sender is not configured", async () => {
    const w = await world();
    meta.configured = false;
    await checkAndNotifyLowStock({ productIds: [w.product.id] });
    expect(sent()).toEqual([]);
    expect(await prismaBase.notification.count({ where: { type: "RUPTURE_STOCK" } })).toBeGreaterThan(0);
  });

  it("another tenant's users never receive it", async () => {
    const w = await world();
    await prismaBase.tenant.create({ data: { id: "tenant-b-0058", name: "B", slug: "tenant-b-0058" } });
    await prismaBase.integration.create({ data: { tenantId: "tenant-b-0058", provider: "WHATSAPP", status: "CONNECTE" } });
    const bOwner = await createTestUser({ role: "OWNER", tenantId: "tenant-b-0058" });
    const bPhone = await setWhatsApp(bOwner.id);
    await runWithTenant(DEFAULT_TENANT_ID, "test", () => checkAndNotifyLowStock({ productIds: [w.product.id] }));
    expect(sentTo()).not.toContain(bPhone);
    expect(sentTo()).toEqual([w.phone.owner, w.phone.admin, w.phone.storeA].sort());
  });
});

describe("integration down (no location)", () => {
  it("sends asoditech_integration_down to integrations.view holders, actor excluded, once per day", async () => {
    const w = await world();
    await notifyConnectionError({ entityType: "Integration", entityId: "int-1", label: "WooCommerce", recipientPermission: "integrations.view" }, w.admin.id);
    await notifyConnectionError({ entityType: "Integration", entityId: "int-1", label: "WooCommerce", recipientPermission: "integrations.view" }, w.admin.id);
    expect(sent()).toEqual([{ to: w.phone.owner, templateName: "asoditech_integration_down", parameters: ["WooCommerce"] }]);
  });
});

describe("delivery failures (bundled)", () => {
  const shipment = (id: string, providerName = "Amana") => ({ id, orderId: `o-${id}`, orderNumber: 1, providerName });

  it("one summary per recipient for a batch of failures, never one per shipment; in-app stays per shipment", async () => {
    const w = await world();
    await notifyShipmentsFailed([shipment("s1"), shipment("s2", "OzonExpress"), shipment("s3")], null);

    // delivery.view, no location scope: Owner, Admin, both store users (verified + opted in)
    expect(sentTo()).toEqual([w.phone.owner, w.phone.admin, w.phone.storeA, w.phone.storeB].sort());
    expect(sentTo("asoditech_delivery_failure_summary")).toHaveLength(4);
    expect(sent()[0].parameters).toEqual(["3", "Amana, OzonExpress"]);
    expect(await prismaBase.notification.count({ where: { type: "ECHEC_LIVRAISON", userId: w.owner.id } })).toBe(3);
  });

  it("at most one delivery-failure WhatsApp per recipient per day; later failures stay in-app (and email)", async () => {
    const w = await world();
    await notifyShipmentsFailed([shipment("s1")], null);
    await notifyShipmentsFailed([shipment("s2")], null);
    await Promise.all([notifyShipmentsFailed([shipment("s3")], null), notifyShipmentsFailed([shipment("s4")], null)]);
    expect(sentTo()).toEqual([w.phone.owner, w.phone.admin, w.phone.storeA, w.phone.storeB].sort());
    expect(await prismaBase.notification.count({ where: { type: "ECHEC_LIVRAISON", userId: w.owner.id } })).toBe(4);

    // Next UTC day: a new failure sends again.
    await prismaBase.user.updateMany({ data: { whatsappDeliveryFailureNotifiedAt: new Date(Date.now() - 36 * 3600_000) } });
    await notifyShipmentsFailed([shipment("s5")], null);
    expect(sent()).toHaveLength(8);
  });

  it("a reprocessed failure (same shipment) sends nothing", async () => {
    await world();
    await prismaBase.user.updateMany({ data: { whatsappDeliveryFailureNotifiedAt: null } });
    await notifyShipmentsFailed([shipment("s1")], null);
    const first = sent().length;
    await prismaBase.user.updateMany({ data: { whatsappDeliveryFailureNotifiedAt: null } }); // even with the daily claim free
    await notifyShipmentsFailed([shipment("s1")], null);
    expect(sent()).toHaveLength(first);
  });
});

describe("excluded events never use WhatsApp", () => {
  it("low stock, new order, payment problem, usage 80/90/100 % stay off WhatsApp", async () => {
    const w = await world();
    await checkAndNotifyLowStock({ productIds: [w.product.id], variationIds: [] }); // itemA out → sends; reset below
    meta.sendTemplateMessage.mockClear();
    await prisma.inventoryItem.update({ where: { id: w.itemA.id }, data: { quantityOnHand: 4 } });
    await prismaBase.notification.deleteMany();
    await checkAndNotifyLowStock({ productIds: [w.product.id] }); // both items low only
    await notifyNewOrder({ id: "o1", orderNumber: 1, total: 10, currency: "MAD", customerName: "Client", source: "INTERNE" });
    await notifyPaymentProblem({ id: "o1", orderNumber: 1 });
    for (const percent of [80, 90, 100]) {
      await checkAndNotifyUsageThreshold(DEFAULT_TENANT_ID, "ORDERS", { used: percent, limit: 100, percent, status: "WARNING" });
    }
    expect(sent()).toEqual([]);
    expect(await prismaBase.notification.count({ where: { type: { in: ["STOCK_FAIBLE", "NOUVELLE_COMMANDE", "USAGE_LIMIT_ALERT"] } } })).toBeGreaterThan(0);
  });
});

describe("failure safety", () => {
  it("a Meta failure (error result or thrown) never breaks the stock adjustment", async () => {
    const w = await world();
    meta.sendTemplateMessage.mockImplementation(async () => {
      throw new Error("Meta down");
    });
    const actor = await loginAsTestUser({ role: "WAREHOUSE" });
    await grantLocationAccess(actor.id, w.whB.id);
    const fd = new FormData();
    for (const [k, v] of Object.entries({ productId: w.product.id, warehouseId: w.whB.id, type: "AJUSTEMENT_NEGATIF", quantity: "3", reason: "Casse" })) fd.set(k, v);
    const result = await adjustInventoryAction(fd);
    expect(result.ok).toBe(true);
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: w.itemB.id } })).quantityOnHand).toBe(0);
    expect(meta.sendTemplateMessage).toHaveBeenCalled();
    expect(await prismaBase.notification.count({ where: { type: "RUPTURE_STOCK", entityId: w.itemB.id } })).toBeGreaterThan(0);
  });

  it("missing central configuration never breaks the stock adjustment", async () => {
    const w = await world();
    meta.configured = false;
    const actor = await loginAsTestUser({ role: "OWNER" });
    const fd = new FormData();
    for (const [k, v] of Object.entries({ productId: w.product.id, warehouseId: w.whB.id, type: "AJUSTEMENT_NEGATIF", quantity: "3", reason: "Casse" })) fd.set(k, v);
    expect((await adjustInventoryAction(fd)).ok).toBe(true);
    expect(actor.id).toBeTruthy();
    expect(sent()).toEqual([]);
  });
});
