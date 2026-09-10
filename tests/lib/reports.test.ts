import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getSalesReport } from "@/lib/queries/reports/sales";
import { getStockValuationReport } from "@/lib/queries/reports/stock-valuation";
import { getDeliveryPerformanceReport } from "@/lib/queries/reports/delivery";
import { getCustomerReport } from "@/lib/queries/reports/customers";
import { getProductProfitReport } from "@/lib/queries/reports/product-profit";
import { resetDb } from "../helpers/db";

const RANGE = { from: new Date("2026-06-01"), to: new Date("2026-06-30T23:59:59") };
const PREV = { from: new Date("2026-05-01"), to: new Date("2026-05-31T23:59:59") };

async function customer(name: string, city?: string) {
  return prisma.customer.create({ data: { fullName: name, city } });
}

async function order(opts: {
  customerId: string;
  status?: string;
  paymentStatus?: string;
  total: number;
  placedAt: Date;
  qty?: number;
  cost?: number | null;
}) {
  const product = await prisma.product.create({
    data: { name: "P", sku: `S-${Math.random()}`, price: opts.total, cost: opts.cost ?? null, status: "ACTIF" },
  });
  return prisma.order.create({
    data: {
      customerId: opts.customerId,
      status: (opts.status ?? "LIVREE") as never,
      paymentStatus: (opts.paymentStatus ?? "PAYE") as never,
      subtotal: opts.total,
      total: opts.total,
      currency: "MAD",
      placedAt: opts.placedAt,
      items: {
        create: {
          productId: product.id,
          nameSnapshot: "P",
          skuSnapshot: "S",
          unitPrice: opts.total,
          quantity: opts.qty ?? 1,
          total: opts.total,
          costSnapshot: opts.cost ?? null,
        },
      },
    },
  });
}

describe("getSalesReport", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("counts revenue only for non-excluded orders and computes the comparison delta", async () => {
    const c = await customer("A");
    await order({ customerId: c.id, total: 100, placedAt: new Date("2026-06-10") });
    await order({ customerId: c.id, total: 50, placedAt: new Date("2026-06-12"), status: "ANNULEE" });
    await order({ customerId: c.id, total: 40, placedAt: new Date("2026-05-10") }); // previous period

    const report = await getSalesReport(RANGE, PREV);
    expect(report.current.ordersCount).toBe(2);
    expect(report.current.revenue).toBe(100); // cancelled order excluded
    expect(report.previous.revenue).toBe(40);
    expect(report.deltas.revenue).toBe(150); // (100-40)/40 * 100
    expect(report.current.deliveryRate).toBe(50); // 1 of 2 orders LIVREE
  });

  it("uses daily granularity for a month and monthly for a year", async () => {
    const c = await customer("A");
    await order({ customerId: c.id, total: 100, placedAt: new Date("2026-06-10") });

    const monthly = await getSalesReport(RANGE, PREV);
    expect(monthly.granularity).toBe("day");
    expect(monthly.series.length).toBeGreaterThan(28);

    const yearly = await getSalesReport(
      { from: new Date("2026-01-01"), to: new Date("2026-12-31T23:59:59") },
      { from: new Date("2025-01-01"), to: new Date("2025-12-31T23:59:59") }
    );
    expect(yearly.granularity).toBe("month");
    expect(yearly.series).toHaveLength(12);
    expect(yearly.series[5].revenue).toBe(100); // June bucket
  });
});

describe("getStockValuationReport", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("values on-hand stock at cost and retail and flags dormant items", async () => {
    const wh = await prisma.warehouse.create({ data: { name: "W", isDefault: true } });
    const sold = await prisma.product.create({ data: { name: "Sold", sku: "SOLD", price: 100, cost: 60, status: "ACTIF" } });
    const dormant = await prisma.product.create({ data: { name: "Dormant", sku: "DEAD", price: 30, cost: 10, status: "ACTIF" } });
    await prisma.inventoryItem.create({ data: { warehouseId: wh.id, productId: sold.id, quantityOnHand: 5 } });
    await prisma.inventoryItem.create({ data: { warehouseId: wh.id, productId: dormant.id, quantityOnHand: 8 } });

    const c = await customer("A");
    await prisma.order.create({
      data: {
        customerId: c.id, status: "LIVREE", subtotal: 100, total: 100, currency: "MAD", placedAt: new Date(),
        items: { create: { productId: sold.id, nameSnapshot: "Sold", skuSnapshot: "SOLD", unitPrice: 100, quantity: 2, total: 200, costSnapshot: 60 } },
      },
    });

    const report = await getStockValuationReport({ dormantDays: 30 });
    expect(report.totals.valueAtCost).toBe(5 * 60 + 8 * 10);
    expect(report.totals.valueAtRetail).toBe(5 * 100 + 8 * 30);
    expect(report.totals.dormantSkuCount).toBe(1);
    const dead = report.rows.find((r) => r.sku === "DEAD");
    expect(dead?.dormant).toBe(true);
    expect(report.rows.find((r) => r.sku === "SOLD")?.dormant).toBe(false);
  });
});

describe("getDeliveryPerformanceReport", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("breaks shipments down by carrier and computes success rate + COD pending", async () => {
    const c = await customer("A", "Casablanca");
    const o1 = await order({ customerId: c.id, total: 100, placedAt: new Date("2026-06-10"), paymentStatus: "EN_ATTENTE" });
    const o2 = await order({ customerId: c.id, total: 200, placedAt: new Date("2026-06-11"), paymentStatus: "PAYE" });
    const prov = await prisma.shippingProvider.create({ data: { name: "OzonExpress", type: "MANUEL" } });
    await prisma.shipment.create({ data: { orderId: o1.id, providerId: prov.id, status: "LIVRE", cost: 20, createdAt: new Date("2026-06-12") } });
    await prisma.shipment.create({ data: { orderId: o2.id, providerId: prov.id, status: "ECHEC", cost: 20, createdAt: new Date("2026-06-13") } });

    const report = await getDeliveryPerformanceReport(RANGE);
    expect(report.overall.total).toBe(2);
    expect(report.overall.delivered).toBe(1);
    expect(report.overall.successRate).toBe(50);
    expect(report.overall.codPending).toBe(100); // delivered + payment EN_ATTENTE
    expect(report.byProvider[0].key).toBe("OzonExpress");
  });

  // Client feedback #3: a cancelled order's parcel, or a cancelled
  // shipment, completed no delivery service — its recorded cost must not
  // land in the report's delivery-cost figure.
  it("excludes a cancelled order's and a cancelled shipment's cost from deliveryCost", async () => {
    const c = await customer("A", "Casablanca");
    const delivered = await order({ customerId: c.id, total: 100, placedAt: new Date("2026-06-10") });
    const cancelledOrder = await order({
      customerId: c.id,
      total: 200,
      placedAt: new Date("2026-06-11"),
      status: "ANNULEE",
    });
    const liveOrder = await order({ customerId: c.id, total: 150, placedAt: new Date("2026-06-12") });
    const prov = await prisma.shippingProvider.create({ data: { name: "OzonExpress", type: "MANUEL" } });
    await prisma.shipment.create({
      data: { orderId: delivered.id, providerId: prov.id, status: "LIVRE", cost: 25, createdAt: new Date("2026-06-13") },
    });
    await prisma.shipment.create({
      data: { orderId: cancelledOrder.id, providerId: prov.id, status: "EN_ATTENTE", cost: 40, createdAt: new Date("2026-06-13") },
    });
    await prisma.shipment.create({
      data: { orderId: liveOrder.id, providerId: prov.id, status: "ANNULE", cost: 30, createdAt: new Date("2026-06-13") },
    });

    const report = await getDeliveryPerformanceReport(RANGE);
    expect(report.overall.deliveryCost).toBe(25); // only the delivered parcel
  });
});

describe("getCustomerReport", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("classifies new vs returning by first-ever order date", async () => {
    const newbie = await customer("New");
    const loyal = await customer("Loyal");
    await order({ customerId: loyal.id, total: 50, placedAt: new Date("2026-03-01") }); // history before window
    await order({ customerId: loyal.id, total: 80, placedAt: new Date("2026-06-05") });
    await order({ customerId: newbie.id, total: 120, placedAt: new Date("2026-06-06") });

    const report = await getCustomerReport(RANGE);
    expect(report.totals.distinctBuyers).toBe(2);
    expect(report.totals.newCustomers).toBe(1);
    expect(report.totals.returningCustomers).toBe(1);
    expect(report.totals.repeatRatePct).toBe(50);
  });
});

describe("getProductProfitReport", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("reports null margin when any line is missing its cost snapshot", async () => {
    const c = await customer("A");
    await order({ customerId: c.id, total: 100, placedAt: new Date("2026-06-10"), cost: null });
    const report = await getProductProfitReport(RANGE);
    expect(report.totals.revenue).toBe(100);
    expect(report.totals.grossProfit).toBeNull();
    expect(report.totals.cogsComplete).toBe(false);
  });
});
