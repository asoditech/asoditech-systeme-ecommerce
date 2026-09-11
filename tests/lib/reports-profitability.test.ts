import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { hasPermission } from "@/lib/auth/permissions";
import {
  getProfitabilityReport,
  listOrdersForProduct,
  listOrdersForCampaign,
  NO_CAMPAIGN_KEY,
} from "@/lib/queries/reports/profitability";
import { resetDb } from "../helpers/db";

const RANGE = { from: new Date("2026-06-01"), to: new Date("2026-06-30T23:59:59") };

async function customer(name: string) {
  return prisma.customer.create({ data: { fullName: name } });
}

async function product(name: string, cost: number | null = null) {
  return prisma.product.create({ data: { name, sku: `S-${Math.random()}`, price: 100, cost, status: "ACTIF" } });
}

interface ItemSpec {
  productId: string | null;
  name: string;
  qty: number;
  unitPrice: number;
  costSnapshot: number | null;
}

async function makeOrder(opts: {
  customerId: string;
  status?: string;
  placedAt: Date;
  campaignId?: string | null;
  items: ItemSpec[];
}) {
  const total = opts.items.reduce((s, i) => s + i.qty * i.unitPrice, 0);
  return prisma.order.create({
    data: {
      customerId: opts.customerId,
      status: (opts.status ?? "LIVREE") as never,
      subtotal: total,
      total,
      currency: "MAD",
      placedAt: opts.placedAt,
      campaignId: opts.campaignId ?? null,
      items: {
        create: opts.items.map((i) => ({
          productId: i.productId,
          nameSnapshot: i.name,
          skuSnapshot: i.name,
          unitPrice: i.unitPrice,
          quantity: i.qty,
          total: i.qty * i.unitPrice,
          costSnapshot: i.costSnapshot,
        })),
      },
    },
  });
}

async function shippingProvider() {
  return prisma.shippingProvider.create({ data: { name: `Prov-${Math.random()}`, type: "MANUEL" } });
}

async function shipment(orderId: string, providerId: string, cost: number, status = "LIVRE") {
  return prisma.shipment.create({ data: { orderId, providerId, cost, status: status as never } });
}

async function campaign(name: string) {
  const channel = await prisma.marketingChannel.create({ data: { name: "Facebook", type: "META" } });
  return prisma.marketingCampaign.create({ data: { name, channelId: channel.id, startDate: new Date("2026-06-01") } });
}

describe("getProfitabilityReport", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("aggregates revenue per product from the persisted line totals", async () => {
    const c = await customer("A");
    const p = await product("Chaise", 40);
    await makeOrder({ customerId: c.id, placedAt: new Date("2026-06-10"), items: [{ productId: p.id, name: "Chaise", qty: 2, unitPrice: 100, costSnapshot: 40 }] });

    const report = await getProfitabilityReport(RANGE);
    const row = report.byProduct.find((r) => r.productId === p.id);
    expect(row?.revenue).toBe(200);
    expect(row?.unitsSold).toBe(2);
  });

  it("computes product cost from OrderItem.costSnapshot, never from the current Product.cost", async () => {
    const c = await customer("A");
    // Product.cost is 999 today — the sale happened at a frozen cost of 40.
    const p = await product("Chaise", 999);
    await makeOrder({ customerId: c.id, placedAt: new Date("2026-06-10"), items: [{ productId: p.id, name: "Chaise", qty: 2, unitPrice: 100, costSnapshot: 40 }] });

    const report = await getProfitabilityReport(RANGE);
    const row = report.byProduct.find((r) => r.productId === p.id);
    expect(row?.productCost).toBe(80); // 2 * 40, not 2 * 999
    expect(row?.dataComplete).toBe(true);
  });

  it("marks a row and the total incomplete when a line has no costSnapshot, instead of treating cost as zero", async () => {
    const c = await customer("A");
    const p = await product("Chaise", 40);
    await makeOrder({ customerId: c.id, placedAt: new Date("2026-06-10"), items: [{ productId: p.id, name: "Chaise", qty: 1, unitPrice: 100, costSnapshot: null }] });

    const report = await getProfitabilityReport(RANGE);
    const row = report.byProduct.find((r) => r.productId === p.id);
    expect(row?.dataComplete).toBe(false);
    expect(row?.productCost).toBeNull();
    expect(row?.profit).toBeNull(); // never guessed as revenue - 0
    expect(row?.linesMissingCost).toBe(1);
    expect(report.totals.dataComplete).toBe(false);
    expect(report.totals.ordersMissingCost).toBe(1);
  });

  it("allocates a multi-product order's delivery cost proportionally by line revenue share", async () => {
    const c = await customer("A");
    const a = await product("A", 10);
    const b = await product("B", 5);
    const order = await makeOrder({
      customerId: c.id,
      placedAt: new Date("2026-06-10"),
      items: [
        { productId: a.id, name: "A", qty: 1, unitPrice: 200, costSnapshot: 10 },
        { productId: b.id, name: "B", qty: 1, unitPrice: 100, costSnapshot: 5 },
      ],
    });
    const prov = await shippingProvider();
    await shipment(order.id, prov.id, 30);

    const report = await getProfitabilityReport(RANGE);
    expect(report.byProduct.find((r) => r.productId === a.id)?.deliveryCost).toBe(20);
    expect(report.byProduct.find((r) => r.productId === b.id)?.deliveryCost).toBe(10);
  });

  it("a cancelled (ANNULEE) order incurs zero delivery cost, and contributes no revenue/cost either", async () => {
    const c = await customer("A");
    const p = await product("Chaise", 40);
    const order = await makeOrder({
      customerId: c.id,
      status: "ANNULEE",
      placedAt: new Date("2026-06-10"),
      items: [{ productId: p.id, name: "Chaise", qty: 1, unitPrice: 100, costSnapshot: 40 }],
    });
    const prov = await shippingProvider();
    await shipment(order.id, prov.id, 40, "EN_ATTENTE");

    const report = await getProfitabilityReport(RANGE);
    const row = report.byProduct.find((r) => r.productId === p.id);
    expect(row?.deliveryCost).toBe(0);
    expect(row?.revenue).toBe(0);
    expect(row?.profit).toBe(0);
  });

  it("a RETOUR order preserves its configured return-rule delivery cost even though it earns no revenue", async () => {
    const c = await customer("A");
    const p = await product("Chaise", 40);
    const order = await makeOrder({
      customerId: c.id,
      status: "RETOUR",
      placedAt: new Date("2026-06-10"),
      items: [{ productId: p.id, name: "Chaise", qty: 1, unitPrice: 100, costSnapshot: 40 }],
    });
    const prov = await shippingProvider();
    await shipment(order.id, prov.id, 15, "RETOURNE");

    const report = await getProfitabilityReport(RANGE);
    const row = report.byProduct.find((r) => r.productId === p.id);
    expect(row?.deliveryCost).toBe(15);
    expect(row?.revenue).toBe(0);
    expect(row?.productCost).toBe(0);
    expect(row?.profit).toBe(-15);
  });

  it("an ECHEC (failed delivery) order preserves its configured failure-rule delivery cost", async () => {
    const c = await customer("A");
    const p = await product("Chaise", 40);
    const order = await makeOrder({
      customerId: c.id,
      status: "ECHEC",
      placedAt: new Date("2026-06-10"),
      items: [{ productId: p.id, name: "Chaise", qty: 1, unitPrice: 100, costSnapshot: 40 }],
    });
    const prov = await shippingProvider();
    await shipment(order.id, prov.id, 10, "ECHEC");

    const report = await getProfitabilityReport(RANGE);
    const row = report.byProduct.find((r) => r.productId === p.id);
    expect(row?.deliveryCost).toBe(10);
    expect(row?.revenue).toBe(0);
    expect(row?.profit).toBe(-10);
  });

  it("groups orders by Order.campaignId", async () => {
    const c = await customer("A");
    const p = await product("Chaise", 40);
    const camp = await campaign("Ramadan");
    await makeOrder({ customerId: c.id, placedAt: new Date("2026-06-10"), campaignId: camp.id, items: [{ productId: p.id, name: "Chaise", qty: 1, unitPrice: 100, costSnapshot: 40 }] });
    await makeOrder({ customerId: c.id, placedAt: new Date("2026-06-11"), campaignId: camp.id, items: [{ productId: p.id, name: "Chaise", qty: 1, unitPrice: 100, costSnapshot: 40 }] });

    const report = await getProfitabilityReport(RANGE);
    const row = report.byCampaign.find((r) => r.campaignId === camp.id);
    expect(row?.name).toBe("Ramadan");
    expect(row?.ordersCount).toBe(2);
    expect(row?.revenue).toBe(200);
  });

  it("buckets a null campaignId as \"Sans campagne\", never renamed to a channel", async () => {
    const c = await customer("A");
    const p = await product("Chaise", 40);
    await makeOrder({ customerId: c.id, placedAt: new Date("2026-06-10"), items: [{ productId: p.id, name: "Chaise", qty: 1, unitPrice: 100, costSnapshot: 40 }] });

    const report = await getProfitabilityReport(RANGE);
    const row = report.byCampaign.find((r) => r.campaignId === null);
    expect(row?.name).toBe("Sans campagne");
    expect(row?.key).toBe(NO_CAMPAIGN_KEY);
  });

  it("never leaks another tenant's orders into the report", async () => {
    const c = await customer("A");
    const p = await product("Chaise", 40);
    await makeOrder({ customerId: c.id, placedAt: new Date("2026-06-10"), items: [{ productId: p.id, name: "Chaise", qty: 1, unitPrice: 100, costSnapshot: 40 }] });

    await prismaBase.tenant.create({ data: { id: "other-tenant", name: "Other Tenant", slug: "other-tenant" } });
    const otherCustomer = await prismaBase.customer.create({ data: { tenantId: "other-tenant", fullName: "Other" } });
    const otherProduct = await prismaBase.product.create({ data: { tenantId: "other-tenant", name: "Other product", sku: "OTHER-SKU", price: 100, status: "ACTIF" } });
    await prismaBase.order.create({
      data: {
        tenantId: "other-tenant",
        customerId: otherCustomer.id,
        status: "LIVREE",
        subtotal: 500,
        total: 500,
        currency: "MAD",
        placedAt: new Date("2026-06-10"),
        items: { create: { tenantId: "other-tenant", productId: otherProduct.id, nameSnapshot: "Other product", skuSnapshot: "OTHER-SKU", unitPrice: 500, quantity: 1, total: 500, costSnapshot: 100 } },
      },
    });

    const report = await getProfitabilityReport(RANGE);
    expect(report.totals.revenue).toBe(100); // only the default-tenant order
    expect(report.byProduct.some((r) => r.name === "Other product")).toBe(false);
  });

  it("filters strictly by the requested date range (placedAt)", async () => {
    const c = await customer("A");
    const p = await product("Chaise", 40);
    await makeOrder({ customerId: c.id, placedAt: new Date("2026-06-10"), items: [{ productId: p.id, name: "Chaise", qty: 1, unitPrice: 100, costSnapshot: 40 }] });
    await makeOrder({ customerId: c.id, placedAt: new Date("2026-05-15"), items: [{ productId: p.id, name: "Chaise", qty: 1, unitPrice: 100, costSnapshot: 40 }] }); // outside range

    const report = await getProfitabilityReport(RANGE);
    const row = report.byProduct.find((r) => r.productId === p.id);
    expect(row?.revenue).toBe(100);
  });

  it("never double-counts: the total equals the sum of both the per-product and per-campaign breakdowns", async () => {
    const c = await customer("A");
    const p1 = await product("A", 10);
    const p2 = await product("B", 5);
    const camp = await campaign("Été");
    await makeOrder({ customerId: c.id, placedAt: new Date("2026-06-10"), campaignId: camp.id, items: [
      { productId: p1.id, name: "A", qty: 1, unitPrice: 200, costSnapshot: 10 },
      { productId: p2.id, name: "B", qty: 1, unitPrice: 100, costSnapshot: 5 },
    ] });
    await makeOrder({ customerId: c.id, placedAt: new Date("2026-06-12"), items: [{ productId: p1.id, name: "A", qty: 1, unitPrice: 200, costSnapshot: 10 }] });

    const report = await getProfitabilityReport(RANGE);
    const sumByProduct = report.byProduct.reduce((s, r) => s + r.revenue, 0);
    const sumByCampaign = report.byCampaign.reduce((s, r) => s + r.revenue, 0);
    expect(sumByProduct).toBe(report.totals.revenue);
    expect(sumByCampaign).toBe(report.totals.revenue);
  });
});

describe("listOrdersForProduct / listOrdersForCampaign — drill-down", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("paginates the contributing-orders list server-side", async () => {
    const c = await customer("A");
    const p = await product("Chaise", 40);
    for (let i = 0; i < 25; i++) {
      await makeOrder({ customerId: c.id, placedAt: new Date(`2026-06-${String((i % 28) + 1).padStart(2, "0")}`), items: [{ productId: p.id, name: "Chaise", qty: 1, unitPrice: 100, costSnapshot: 40 }] });
    }

    const page1 = await listOrdersForProduct(p.id, RANGE, 1, 10);
    expect(page1.rows).toHaveLength(10);
    expect(page1.total).toBe(25);

    const page3 = await listOrdersForProduct(p.id, RANGE, 3, 10);
    expect(page3.rows).toHaveLength(5);
  });

  it("drill-down totals (summed across all pages) match the aggregate report row", async () => {
    const c = await customer("A");
    const p = await product("Chaise", 40);
    await makeOrder({ customerId: c.id, placedAt: new Date("2026-06-05"), items: [{ productId: p.id, name: "Chaise", qty: 2, unitPrice: 100, costSnapshot: 40 }] });
    const order2 = await makeOrder({ customerId: c.id, placedAt: new Date("2026-06-15"), items: [{ productId: p.id, name: "Chaise", qty: 1, unitPrice: 100, costSnapshot: 40 }] });
    const prov = await shippingProvider();
    await shipment(order2.id, prov.id, 20);

    const report = await getProfitabilityReport(RANGE);
    const aggregateRow = report.byProduct.find((r) => r.productId === p.id);

    const { rows } = await listOrdersForProduct(p.id, RANGE, 1, 100);
    const summedRevenue = rows.reduce((s, r) => s + r.revenue, 0);
    const summedCost = rows.reduce((s, r) => s + (r.productCost ?? 0), 0);
    const summedDelivery = rows.reduce((s, r) => s + r.deliveryCost, 0);

    expect(summedRevenue).toBe(aggregateRow?.revenue);
    expect(summedCost).toBe(aggregateRow?.productCost);
    expect(summedDelivery).toBe(aggregateRow?.deliveryCost);
  });

  it("also matches for campaign drill-down", async () => {
    const c = await customer("A");
    const p = await product("Chaise", 40);
    const camp = await campaign("Ramadan");
    await makeOrder({ customerId: c.id, placedAt: new Date("2026-06-05"), campaignId: camp.id, items: [{ productId: p.id, name: "Chaise", qty: 1, unitPrice: 100, costSnapshot: 40 }] });
    await makeOrder({ customerId: c.id, placedAt: new Date("2026-06-15"), campaignId: camp.id, items: [{ productId: p.id, name: "Chaise", qty: 1, unitPrice: 100, costSnapshot: 40 }] });

    const report = await getProfitabilityReport(RANGE);
    const aggregateRow = report.byCampaign.find((r) => r.campaignId === camp.id);
    expect(aggregateRow).toBeDefined();

    const { rows } = await listOrdersForCampaign(camp.id, RANGE, 1, 100);
    const summedRevenue = rows.reduce((s, r) => s + r.revenue, 0);
    expect(summedRevenue).toBe(aggregateRow?.revenue);
    expect(rows).toHaveLength(aggregateRow!.ordersCount);
  });
});

describe("profitability report — permission enforcement", () => {
  it("is gated behind analytics.view, exactly like the other /rapports pages", () => {
    expect(hasPermission("OWNER", "analytics.view")).toBe(true);
    expect(hasPermission("ADMIN", "analytics.view")).toBe(true);
    expect(hasPermission("MANAGER", "analytics.view")).toBe(true);
    expect(hasPermission("ACCOUNTANT", "analytics.view")).toBe(true);
    expect(hasPermission("WAREHOUSE", "analytics.view")).toBe(false);
    expect(hasPermission("CONFIRMATION", "analytics.view")).toBe(false);
    expect(hasPermission("DELIVERY", "analytics.view")).toBe(false);
    expect(hasPermission("SUPPORT", "analytics.view")).toBe(false);
  });
});
