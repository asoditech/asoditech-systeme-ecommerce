import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { createSaleAction } from "@/actions/sales";
import { getCurrentUser } from "@/lib/auth/session";
import { ensureDefaultOnlineChannel } from "@/lib/channels";
import { resolveReportOnlineChannel, reportOrderScope } from "@/lib/reports/online-channel";
import { getSalesReport } from "@/lib/queries/reports/sales";
import { getCustomerReport } from "@/lib/queries/reports/customers";
import { getProfitabilityReport } from "@/lib/queries/reports/profitability";
import { getProductProfitReport } from "@/lib/queries/reports/product-profit";
import { getDeliveryPerformanceReport } from "@/lib/queries/reports/delivery";
import { getReturnsReport } from "@/lib/queries/reports/returns";
import { GET as exportReport } from "@/app/(protected)/rapports/export/[type]/route";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * B1 — strict filter isolation on /rapports (« Canal en ligne » `?canal=` and
 * the Canaux report's `kind` / store `canal`), enforced server-side: a
 * selected channel narrows EVERY figure, an empty channel gives genuine
 * zeros (never the previous / all-channel values), and a foreign or
 * other-tenant id is ignored — never another tenant's data.
 */

const RANGE = () => ({ from: new Date(Date.now() - 2 * 24 * 3600 * 1000), to: new Date(Date.now() + 24 * 3600 * 1000) });
const PREV = () => ({ from: new Date(Date.now() - 40 * 24 * 3600 * 1000), to: new Date(Date.now() - 39 * 24 * 3600 * 1000) });
const TENANT_B = "tenant-b-reports";

beforeEach(async () => {
  await resetDb();
  await setTestBusinessMode("ONLINE_AND_OFFLINE");
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

/** Two online channels with orders (1 000 / 300) and a third with none. */
async function seedOnline() {
  const web = await ensureDefaultOnlineChannel();
  const shop2 = await prisma.salesChannel.create({ data: { name: "Boutique 2", kind: "ONLINE" } });
  const empty = await prisma.salesChannel.create({ data: { name: "Boutique vide", kind: "ONLINE" } });
  const product = await prisma.product.create({ data: { name: "Basket", sku: "BASKET-1", price: 100, status: "ACTIF", cost: 40 } });
  const provider = await prisma.shippingProvider.create({ data: { name: "Livreur maison", type: "MANUEL" } });
  const mk = async (channelId: string, name: string, qty: number) => {
    const customer = await prisma.customer.create({ data: { fullName: name } });
    const order = await prisma.order.create({
      data: {
        customerId: customer.id, status: "LIVREE", paymentStatus: "PAYE", subtotal: qty * 100, total: qty * 100, salesChannelId: channelId, placedAt: new Date(),
        items: { create: [{ productId: product.id, nameSnapshot: "Basket", skuSnapshot: "BASKET-1", unitPrice: 100, quantity: qty, total: qty * 100, costSnapshot: 40 }] },
      },
    });
    await prisma.shipment.create({ data: { orderId: order.id, providerId: provider.id, status: "LIVRE", cost: 20 } });
    return order;
  };
  const o1 = await mk(web.id, "Client Web", 10);
  const o2 = await mk(shop2.id, "Client B2", 3);
  return { web, shop2, empty, product, o1, o2 };
}

describe("« Canal en ligne » filter on the Online reports", () => {
  it("a selected channel narrows every figure; another channel gives its own figures (no stale value)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const w = await seedOnline();
    const admin = (await getCurrentUser())!;

    const all = await getSalesReport(RANGE(), PREV());
    expect(all.current.revenue).toBe(1300);

    const f2 = await resolveReportOnlineChannel(admin, w.shop2.id);
    expect(f2.salesChannelId).toBe(w.shop2.id);
    const s2 = await getSalesReport(RANGE(), PREV(), reportOrderScope(f2.salesChannelId));
    expect(s2.current).toMatchObject({ ordersCount: 1, revenue: 300, unitsSold: 3 });
    expect(s2.series.reduce((n, b) => n + b.revenue, 0)).toBe(300);

    const f1 = await resolveReportOnlineChannel(admin, w.web.id);
    const s1 = await getSalesReport(RANGE(), PREV(), reportOrderScope(f1.salesChannelId));
    expect(s1.current).toMatchObject({ ordersCount: 1, revenue: 1000 });

    expect((await getCustomerReport(RANGE(), reportOrderScope(w.shop2.id))).totals.distinctBuyers).toBe(1);
    expect((await getProfitabilityReport(RANGE(), reportOrderScope(w.shop2.id))).totals.revenue).toBe(300);
    expect((await getProductProfitReport(RANGE(), reportOrderScope(w.shop2.id))).products.map((p) => p.revenue)).toEqual([300]);
    expect((await getDeliveryPerformanceReport(RANGE(), reportOrderScope(w.shop2.id))).overall.total).toBe(1);
  });

  it("an existing channel with no orders shows genuine zeros, not the all-channel figures", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const w = await seedOnline();
    const admin = (await getCurrentUser())!;
    const f = await resolveReportOnlineChannel(admin, w.empty.id);
    expect(f.salesChannelId).toBe(w.empty.id);
    const scope = reportOrderScope(f.salesChannelId);

    const sales = await getSalesReport(RANGE(), PREV(), scope);
    expect(sales.current).toMatchObject({ ordersCount: 0, revenue: 0, unitsSold: 0 });
    expect(sales.byStatus).toEqual([]);
    expect((await getCustomerReport(RANGE(), scope)).totals.distinctBuyers).toBe(0);
    expect((await getProfitabilityReport(RANGE(), scope)).totals.revenue).toBe(0);
    expect((await getProductProfitReport(RANGE(), scope)).products).toEqual([]);
    expect((await getDeliveryPerformanceReport(RANGE(), scope)).overall.total).toBe(0);
    expect((await getReturnsReport(RANGE(), scope)).totals.returnEvents).toBe(0);
  });

  it("an unknown id, an OFFLINE store id or another tenant's channel is ignored (never widened, never foreign data)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const w = await seedOnline();
    const admin = (await getCurrentUser())!;

    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    const foreign = await prismaBase.salesChannel.create({ data: { tenantId: TENANT_B, name: "B en ligne", kind: "ONLINE" } });
    const custB = await prismaBase.customer.create({ data: { tenantId: TENANT_B, fullName: "Client B" } });
    await prismaBase.order.create({
      data: { tenantId: TENANT_B, customerId: custB.id, status: "LIVREE", subtotal: 9999, total: 9999, salesChannelId: foreign.id, placedAt: new Date() },
    });
    const store = await prisma.salesChannel.create({ data: { name: "Magasin", kind: "OFFLINE" } });

    for (const canal of [foreign.id, store.id, "nope", undefined]) {
      const f = await resolveReportOnlineChannel(admin, canal);
      expect(f.salesChannelId, String(canal)).toBeUndefined();
      expect(f.channels.map((c) => c.id)).not.toContain(foreign.id);
      const r = await getSalesReport(RANGE(), PREV(), reportOrderScope(f.salesChannelId));
      expect(r.current.revenue).toBe(1300); // this tenant's orders only — B's 9 999 never appears
    }
    // Even forced as a raw scope, the tenant-scoped client cannot reach B's orders.
    expect((await getSalesReport(RANGE(), PREV(), reportOrderScope(foreign.id))).current.ordersCount).toBe(0);
    expect(w.o1.id).toBeTruthy();
  });

  it("the CSV export applies the same channel as the page", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const w = await seedOnline();
    const csv = async (q: string) =>
      (await exportReport(new Request(`http://x/rapports/export/ventes?period=month${q}`), { params: Promise.resolve({ type: "ventes" }) })).text();

    const filtered = await csv(`&canal=${w.shop2.id}`);
    expect(filtered).toContain("Canal en ligne : Boutique 2");
    expect(filtered).toContain("300");
    expect(filtered).not.toContain("1300");

    const empty = await csv(`&canal=${w.empty.id}`);
    expect(empty).toContain("Canal en ligne : Boutique vide");
    expect(empty).not.toContain("1300");

    const unfiltered = await csv("");
    expect(unfiltered).not.toContain("Canal en ligne");
    expect(unfiltered).toContain("1300");
  });
});

describe("Canaux report export — `kind` and store `canal` honoured like the page", () => {
  it("one store selected → the CSV only contains that store's sales", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const online = await ensureDefaultOnlineChannel();
    const whA = await prisma.warehouse.create({ data: { name: "Boutique A", type: "MAGASIN", isDefault: true } });
    const whB = await prisma.warehouse.create({ data: { name: "Boutique B", type: "MAGASIN" } });
    const chA = await prisma.salesChannel.create({ data: { name: "Magasin A", kind: "OFFLINE" } });
    const chB = await prisma.salesChannel.create({ data: { name: "Magasin B", kind: "OFFLINE" } });
    const chEmpty = await prisma.salesChannel.create({ data: { name: "Magasin vide", kind: "OFFLINE" } });
    await prisma.salesChannelLocation.createMany({ data: [{ salesChannelId: chA.id, warehouseId: whA.id }, { salesChannelId: chB.id, warehouseId: whB.id }] });
    const product = await prisma.product.create({ data: { name: "Basket", sku: "BASKET-1", price: 100, status: "ACTIF", cost: 40 } });
    await prisma.productSalesChannel.createMany({
      data: [{ productId: product.id, salesChannelId: online.id }, { productId: product.id, salesChannelId: chA.id }, { productId: product.id, salesChannelId: chB.id }],
    });
    await prisma.inventoryItem.createMany({ data: [{ warehouseId: whA.id, productId: product.id, quantityOnHand: 20 }, { warehouseId: whB.id, productId: product.id, quantityOnHand: 20 }] });
    for (const [ch, wh, qty] of [[chA.id, whA.id, 3], [chB.id, whB.id, 2]] as const) {
      const r = await createSaleAction({ salesChannelId: ch, warehouseId: wh, idempotencyKey: randomUUID(), lines: [{ productId: product.id, quantity: qty }], payments: [{ method: "ESPECES", amount: qty * 100 }] });
      expect(r.ok).toBe(true);
    }
    const csv = async (q: string) =>
      (await exportReport(new Request(`http://x/rapports/export/canaux?period=month${q}`), { params: Promise.resolve({ type: "canaux" }) })).text();

    const onlyA = await csv(`&kind=offline&canal=${chA.id}`);
    expect(onlyA).toContain("Magasin A");
    expect(onlyA).not.toContain("Magasin B");
    expect(onlyA).not.toContain("En ligne — chiffre d'affaires");

    const none = await csv(`&kind=offline&canal=${chEmpty.id}`);
    expect(none).not.toContain("Magasin A");
    expect(none).not.toContain("Magasin B");

    const both = await csv("&kind=offline");
    expect(both).toContain("Magasin A");
    expect(both).toContain("Magasin B");
  });
});
