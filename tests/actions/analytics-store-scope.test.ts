import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/session";
import { ensureDefaultOnlineChannel } from "@/lib/channels";
import { createSaleAction, createSaleReturnAction } from "@/actions/sales";
import { resolveAnalyticsPeriod } from "@/lib/analytics/period";
import { parseAnalyticsFilters } from "@/lib/analytics/filters";
import { isBlocked } from "@/lib/analytics/scope";
import { getStoreOverview } from "@/lib/analytics/queries/store";
import { getStoreProductPerformance } from "@/lib/analytics/queries/products";
import { getOfflineReturnsReport } from "@/lib/queries/reports/returns";
import { listOrdersForProduct, getProfitabilityReport } from "@/lib/queries/reports/profitability";
import { reportOrderScope } from "@/lib/reports/online-channel";
import { resolveReportStoreChannel } from "@/lib/reports/store-channel";
import { listSales } from "@/lib/queries/sales";
import { GET as exportAnalytics } from "@/app/(protected)/analyses/export/[type]/route";
import { GET as exportReport } from "@/app/(protected)/rapports/export/[type]/route";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { grantChannelAccess, grantLocationAccess, loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Requirement A — unified analytics / reports filters. DB-backed (NOT run in
 * the implementation pass; run with the test DB):
 *   - /analyses: a store selection changes every section that can honour it
 *     (store KPIs, store products) and BLOCKS the ones that cannot (Online,
 *     commissions, P&L) — no global figure under a store filter;
 *   - « all stores » vs one store; an empty store gives genuine zeros;
 *   - another tenant's store id is ignored and cannot widen the scope;
 *   - /rapports/retours offline section, /ventes list, the CSV exports and
 *     the profitability drill-down follow the same scope.
 */

const TENANT_B = "tenant-b-store-scope";
const now = () => new Date();
const RANGE = () => ({ from: new Date(Date.now() - 2 * 24 * 3600 * 1000), to: new Date(Date.now() + 24 * 3600 * 1000) });
const PERIOD = () => resolveAnalyticsPeriod({ period: "this-month" });

beforeEach(async () => {
  await resetDb();
  await setTestBusinessMode("ONLINE_AND_OFFLINE");
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

/** Store A sells 3 × 100, store B 2 × 100, store « vide » nothing; one Online order of 1 000. */
async function seed() {
  const online = await ensureDefaultOnlineChannel();
  const whA = await prisma.warehouse.create({ data: { name: "Boutique A", type: "MAGASIN", isDefault: true } });
  const whB = await prisma.warehouse.create({ data: { name: "Boutique B", type: "MAGASIN" } });
  const whEmpty = await prisma.warehouse.create({ data: { name: "Boutique vide", type: "MAGASIN" } });
  const chA = await prisma.salesChannel.create({ data: { name: "Magasin A", kind: "OFFLINE" } });
  const chB = await prisma.salesChannel.create({ data: { name: "Magasin B", kind: "OFFLINE" } });
  const chEmpty = await prisma.salesChannel.create({ data: { name: "Magasin vide", kind: "OFFLINE" } });
  await prisma.salesChannelLocation.createMany({
    data: [
      { salesChannelId: chA.id, warehouseId: whA.id },
      { salesChannelId: chB.id, warehouseId: whB.id },
      { salesChannelId: chEmpty.id, warehouseId: whEmpty.id },
    ],
  });
  const product = await prisma.product.create({ data: { name: "Basket", sku: "BASKET-1", price: 100, status: "ACTIF", cost: 40 } });
  await prisma.productSalesChannel.createMany({
    data: [online.id, chA.id, chB.id, chEmpty.id].map((salesChannelId) => ({ productId: product.id, salesChannelId })),
  });
  await prisma.inventoryItem.createMany({
    data: [whA.id, whB.id, whEmpty.id].map((warehouseId) => ({ warehouseId, productId: product.id, quantityOnHand: 20 })),
  });
  const saleIds: Record<string, string> = {};
  for (const [key, ch, wh, qty] of [["A", chA.id, whA.id, 3], ["B", chB.id, whB.id, 2]] as const) {
    const r = await createSaleAction({ salesChannelId: ch, warehouseId: wh, idempotencyKey: randomUUID(), lines: [{ productId: product.id, quantity: qty }], payments: [{ method: "ESPECES", amount: qty * 100 }] });
    expect(r.ok).toBe(true);
    if (r.ok) saleIds[key] = r.data.id;
  }
  const customer = await prisma.customer.create({ data: { fullName: "Client web" } });
  const order = await prisma.order.create({
    data: {
      customerId: customer.id, status: "LIVREE", subtotal: 1000, total: 1000, salesChannelId: online.id, placedAt: now(),
      items: { create: [{ productId: product.id, nameSnapshot: "Basket", skuSnapshot: "BASKET-1", unitPrice: 100, quantity: 10, total: 1000, costSnapshot: 40 }] },
    },
  });
  return { online, whA, whB, whEmpty, chA, chB, chEmpty, product, saleIds, order };
}

async function foreignStore() {
  await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
  return prismaBase.salesChannel.create({ data: { tenantId: TENANT_B, name: "Magasin B-tenant", kind: "OFFLINE" } });
}

describe("/analyses — store filter honoured or explicitly blocked", () => {
  it("one store narrows the store KPIs and products; Online, commissions and P&L are blocked (never global numbers)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const w = await seed();
    const admin = (await getCurrentUser())!;
    const all = parseAnalyticsFilters({});
    const onlyA = parseAnalyticsFilters({ magasin: w.chA.id });

    const sAll = await getStoreOverview(admin, PERIOD(), all);
    expect(sAll.report).toMatchObject({ salesCount: 2, grossSales: 500 });
    const sA = await getStoreOverview(admin, PERIOD(), onlyA);
    expect(sA.report).toMatchObject({ salesCount: 1, grossSales: 300 });
    expect(sA.series.reduce((n, b) => n + b.revenue, 0)).toBe(300);
    expect((await getStoreProductPerformance(admin, PERIOD().range, onlyA, { withFinance: false })).totals.units).toBe(3);

    // The page computes these ONLY when not blocked — under a store they are blocked.
    expect(isBlocked("online", onlyA)).toBe(true);
    expect(isBlocked("commissions", onlyA)).toBe(true);
    expect(isBlocked("pnl", onlyA)).toBe(true);
    expect(isBlocked("store", onlyA)).toBe(false);
    expect(isBlocked("online", all)).toBe(false);
  });

  it("an empty store gives genuine zeros, not the all-store figures", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const w = await seed();
    const admin = (await getCurrentUser())!;
    const s = await getStoreOverview(admin, PERIOD(), parseAnalyticsFilters({ magasin: w.chEmpty.id }));
    expect(s.report).toMatchObject({ salesCount: 0, grossSales: 0, netSales: 0 });
    expect(s.averageSaleValue).toBeNull();
    expect(s.series.every((b) => b.revenue === 0)).toBe(true);
  });

  it("another tenant's store id matches nothing; a scoped manager cannot widen to a store they do not hold", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const w = await seed();
    const admin = (await getCurrentUser())!;
    const foreign = await foreignStore();
    expect((await getStoreOverview(admin, PERIOD(), parseAnalyticsFilters({ magasin: foreign.id }))).report.salesCount).toBe(0);

    const manager = await loginAsTestUser({ role: "MANAGER", channels: "none" });
    await grantChannelAccess(manager.id, w.chA.id);
    await grantLocationAccess(manager.id, w.whA.id);
    const viewer = (await getCurrentUser())!;
    expect((await getStoreOverview(viewer, PERIOD(), parseAnalyticsFilters({}))).report.grossSales).toBe(300);
    expect((await getStoreOverview(viewer, PERIOD(), parseAnalyticsFilters({ magasin: w.chB.id }))).report.salesCount).toBe(0);
  });

  it("CSV: under a store filter the Online parts say « Non filtrable » and carry no Online figure", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const w = await seed();
    const csv = async (type: string, q: string) =>
      (await exportAnalytics(new Request(`http://x/analyses/export/${type}?period=this-month${q}`), { params: Promise.resolve({ type }) })).text();

    const canauxA = await csv("canaux", `&magasin=${w.chA.id}`);
    expect(canauxA).toContain("Périmètre magasin : Magasin : Magasin A");
    expect(canauxA).toContain("Non filtrable par magasin");
    expect(canauxA).toContain("Magasin A");
    expect(canauxA).not.toContain("Magasin B");
    expect(canauxA).not.toContain("1000");

    const revenusA = await csv("revenus", `&magasin=${w.chA.id}`);
    expect(revenusA).toContain("Non filtrable par magasin");
    expect(revenusA).not.toContain("1000");

    const canauxShopify = await csv("canaux", "&source=SHOPIFY");
    expect(canauxShopify).toContain("Non filtrable par origine");
    expect(canauxShopify).not.toContain("Magasin A");

    const unfiltered = await csv("canaux", "");
    expect(unfiltered).not.toContain("Non filtrable");
  });
});

describe("/rapports/retours — offline store filter", () => {
  it("one store / empty store / foreign store", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const w = await seed();
    for (const key of ["A", "B"]) {
      const line = await prisma.saleLine.findFirstOrThrow({ where: { saleId: w.saleIds[key] } });
      const r = await createSaleReturnAction({ saleId: w.saleIds[key], idempotencyKey: randomUUID(), lines: [{ saleLineId: line.id, quantitySellable: 1, quantityDamaged: 0 }], refundAmount: 100, refundMethod: "ESPECES" });
      expect(r.ok).toBe(true);
    }
    const admin = (await getCurrentUser())!;
    expect((await getOfflineReturnsReport(RANGE(), admin)).totals.returnEvents).toBe(2);
    const fA = await resolveReportStoreChannel(admin, w.chA.id);
    expect(fA.salesChannelId).toBe(w.chA.id);
    const a = await getOfflineReturnsReport(RANGE(), admin, { salesChannelId: fA.salesChannelId });
    expect(a.totals).toMatchObject({ returnEvents: 1, refundTotal: 100 });
    expect(a.bySale.map((s) => s.channelName)).toEqual(["Magasin A"]);
    expect((await getOfflineReturnsReport(RANGE(), admin, { salesChannelId: w.chEmpty.id })).totals.returnEvents).toBe(0);

    const foreign = await foreignStore();
    const fF = await resolveReportStoreChannel(admin, foreign.id);
    expect(fF.salesChannelId).toBeUndefined();
    expect(fF.channels.map((c) => c.id)).not.toContain(foreign.id);
    expect((await resolveReportStoreChannel(admin, w.online.id)).salesChannelId).toBeUndefined(); // an ONLINE id is not a store

    const csv = await (await exportReport(new Request(`http://x/rapports/export/retours?period=month&magasin=${w.chA.id}`), { params: Promise.resolve({ type: "retours" }) })).text();
    expect(csv).toContain("Magasin — Résumé (Magasin : Magasin A)");
    expect(csv).not.toContain("Magasin B");
  });
});

describe("/ventes — store filter cannot widen a scoped viewer", () => {
  it("listSales ANDs the store id onto the viewer scope", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const w = await seed();
    const admin = (await getCurrentUser())!;
    expect((await listSales(admin, {})).total).toBe(2);
    expect((await listSales(admin, { salesChannelId: w.chA.id })).total).toBe(1);
    expect((await listSales(admin, { salesChannelId: w.chEmpty.id })).total).toBe(0);

    const manager = await loginAsTestUser({ role: "MANAGER", channels: "none" });
    await grantChannelAccess(manager.id, w.chA.id);
    await grantLocationAccess(manager.id, w.whA.id);
    const viewer = (await getCurrentUser())!;
    // Before the fix, the spread replaced `salesChannelId: { in: [A] }` → B's sale leaked.
    expect((await listSales(viewer, { salesChannelId: w.chB.id })).total).toBe(0);
  });
});

describe("/rapports/profitabilite drill-down keeps the « Canal en ligne » scope", () => {
  it("listOrdersForProduct with the parent's scope matches the clicked row", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const w = await seed();
    const shop2 = await prisma.salesChannel.create({ data: { name: "Boutique 2", kind: "ONLINE" } });
    const c2 = await prisma.customer.create({ data: { fullName: "Client 2" } });
    await prisma.order.create({
      data: {
        customerId: c2.id, status: "LIVREE", subtotal: 300, total: 300, salesChannelId: shop2.id, placedAt: now(),
        items: { create: [{ productId: w.product.id, nameSnapshot: "Basket", skuSnapshot: "BASKET-1", unitPrice: 100, quantity: 3, total: 300, costSnapshot: 40 }] },
      },
    });
    const scope = reportOrderScope(shop2.id);
    const row = (await getProfitabilityReport(RANGE(), scope)).byProduct.find((r) => r.productId === w.product.id)!;
    expect(row.revenue).toBe(300);
    const page = await listOrdersForProduct(w.product.id, RANGE(), 1, 20, scope);
    expect(page.total).toBe(1);
    expect(page.rows.reduce((n, r) => n + r.revenue, 0)).toBe(300);
    expect((await listOrdersForProduct(w.product.id, RANGE(), 1, 20)).total).toBe(2);
  });
});
