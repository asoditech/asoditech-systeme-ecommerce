import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OrderStatus, ShipmentStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/session";
import { getDashboardData, getRevenueTrend } from "@/lib/queries/dashboard";
import { currentMonthRange, getFinanceSummary, previousPeriodOfSameLength } from "@/lib/queries/finance";
import { getDeliveryStats } from "@/lib/queries/delivery";
import { getSalesReport } from "@/lib/queries/reports/sales";
import { getCustomerReport } from "@/lib/queries/reports/customers";
import { getCashflowReport } from "@/lib/queries/reports/cashflow";
import { getDeliveryPerformanceReport } from "@/lib/queries/reports/delivery";
import { getLowStockCount, listInventoryItems } from "@/lib/queries/inventory";
import { checkAndNotifyLowStock } from "@/lib/notifications";
import { getConfirmationAnalytics, getOnlineOverview, getOnlineSourceFunnel } from "@/lib/analytics/queries/online";
import { resolveAnalyticsPeriod } from "@/lib/analytics/period";
import { asPct } from "@/lib/metrics/formulas";
import { zonedParts } from "@/lib/time/zoned";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * S6 — one label, one number: the same period read from the dashboard,
 * Finance, /analyses and every /rapports page gives the same « Chiffre
 * d'affaires », « Commandes », « Taux de confirmation », « Taux de livraison
 * réussie », « Nouveaux clients » and « Remboursé ».
 *
 * This month (business time zone), 7 orders:
 *   O1 LIVREE    300  confirmed, parcel LIVRE, 50 refunded          — C1 (record imported last year, 1st order now)
 *   O2 LIVREE    200  confirmed, parcel ECHEC then re-sent LIVRE    — C2 (already ordered last year)
 *   O3 EXPEDIEE  150  confirmed, parcel ECHEC                       — C3
 *   O4 RETOUR    120  confirmed, parcel RETOURNE                    — C4
 *   O5 ANNULEE   400  called (« Annulé »), never confirmed           — C5
 *   O6 NOUVELLE   80  never called                                  — C6
 *   O7 ECHEC      90  imported failed, never confirmed, no parcel    — C7
 */
const TZ = "Africa/Casablanca";

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

async function seedMonth() {
  const now = Date.now();
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000);
  const provider = await prisma.shippingProvider.create({ data: { name: "Livreur", type: "MANUEL" } });
  const user = (await getCurrentUser())!;
  const customer = (name: string, createdAt?: Date) => prisma.customer.create({ data: { fullName: name, ...(createdAt ? { createdAt } : {}) } });
  async function order(o: {
    customerId: string;
    status: OrderStatus;
    total: number;
    confirmed?: boolean;
    attempt?: "CONFIRME" | "ANNULE";
    parcels?: ShipmentStatus[];
    refund?: number;
  }) {
    const created = await prisma.order.create({
      data: {
        customerId: o.customerId,
        status: o.status,
        subtotal: o.total,
        total: o.total,
        placedAt: at(120),
        confirmedAt: o.confirmed ? at(110) : null,
        shippedAt: ["EXPEDIEE", "LIVREE", "RETOUR", "ECHEC"].includes(o.status) && o.parcels ? at(100) : null,
      },
    });
    if (o.attempt) {
      await prisma.orderConfirmationAttempt.create({ data: { orderId: created.id, agentUserId: user.id, outcome: o.attempt, createdAt: at(110) } });
    }
    for (const [i, status] of (o.parcels ?? []).entries()) {
      await prisma.shipment.create({ data: { orderId: created.id, providerId: provider.id, status, createdAt: at(90 - i * 10) } });
    }
    if (o.refund) await prisma.refund.create({ data: { orderId: created.id, amount: o.refund, status: "COMPLETE" } });
    return created;
  }

  const lastYear = new Date(now - 400 * 24 * 3600 * 1000);
  const c1 = await customer("C1", lastYear);
  const c2 = await customer("C2", lastYear);
  await prisma.order.create({ data: { customerId: c2.id, status: "LIVREE", subtotal: 10, total: 10, placedAt: lastYear } });
  await order({ customerId: c1.id, status: "LIVREE", total: 300, confirmed: true, attempt: "CONFIRME", parcels: ["LIVRE"], refund: 50 });
  await order({ customerId: c2.id, status: "LIVREE", total: 200, confirmed: true, attempt: "CONFIRME", parcels: ["ECHEC", "LIVRE"] });
  await order({ customerId: (await customer("C3")).id, status: "EXPEDIEE", total: 150, confirmed: true, attempt: "CONFIRME", parcels: ["ECHEC"] });
  await order({ customerId: (await customer("C4")).id, status: "RETOUR", total: 120, confirmed: true, attempt: "CONFIRME", parcels: ["RETOURNE"] });
  await order({ customerId: (await customer("C5")).id, status: "ANNULEE", total: 400, attempt: "ANNULE" });
  await order({ customerId: (await customer("C6")).id, status: "NOUVELLE", total: 80 });
  await prisma.order.create({
    data: { customerId: (await customer("C7")).id, status: "ECHEC", subtotal: 90, total: 90, placedAt: at(120), shippedAt: at(100) },
  });
}

describe("one label, one number — across dashboard, Finance, /analyses and /rapports", () => {
  it("revenue, orders, confirmation, delivery, new customers and refunds agree", async () => {
    // Away from a month boundary, so « ce mois » and « 30 derniers jours » can't split the fixture.
    if (zonedParts(new Date(), TZ).day === 1 && zonedParts(new Date(), TZ).hour < 1) return;
    await loginAsTestUser({ role: "OWNER" });
    await seedMonth();

    const month = currentMonthRange(TZ);
    const period = resolveAnalyticsPeriod({ period: "this-month" }, new Date(), TZ);
    const [dashboard, finance, overview, sales, confirmation, funnel, customers, cash, trend] = await Promise.all([
      getDashboardData("mois"),
      getFinanceSummary(month),
      getOnlineOverview(period.range, {}),
      getSalesReport(month, previousPeriodOfSameLength(month)),
      getConfirmationAnalytics(period, {}),
      getOnlineSourceFunnel(period.range, {}),
      getCustomerReport(month),
      getCashflowReport(month),
      getRevenueTrend("annee"),
    ]);

    // « Chiffre d'affaires » — 300 + 200 + 150 + 80 (NOUVELLE counts) − 50 refunded = 680.
    expect(finance.revenue).toBe(680);
    expect(dashboard.finance.revenue).toBe(680);
    expect(overview.netRevenue).toBe(680);
    expect(sales.current.revenue).toBe(680);
    expect(funnel.reduce((n, r) => n + r.revenue, 0)).toBe(680);
    const monthKey = `${zonedParts(new Date(), TZ).year}-${zonedParts(new Date(), TZ).month - 1}`;
    expect(trend.find((b) => b.key === monthKey)?.revenue).toBe(680);

    // « Commandes » — every order placed, any status.
    expect(dashboard.ordersPlaced).toBe(7);
    expect(overview.orders).toBe(7);
    expect(sales.current.ordersCount).toBe(7);

    // « Taux de confirmation » — 4 confirmed ÷ 5 called (O6 never called; O7 failed but never confirmed).
    expect(overview.confirmed).toBe(4);
    expect(overview.confirmationRate).toBe(80);
    expect(sales.current.confirmationRate).toBe(80);
    expect(confirmation.confirmationRate).toBe(80);

    // « Taux de livraison réussie », per order — O1, O2 (re-sent) delivered; O3, O7 failed; O4 returned → 2 ÷ 5.
    expect(overview.deliveryRate).toBe(40);
    expect(sales.current.deliveryRate).toBe(40);
    // Delivery screens count SHIPMENTS: O7 never had one (the only, documented, difference) → 2 ÷ 4.
    const stats = await getDeliveryStats(month.from, month.to);
    const deliveryReport = await getDeliveryPerformanceReport(month);
    expect(stats).toMatchObject({ total: 4, delivered: 2, failed: 1, returned: 1 });
    expect(asPct(stats.successRate)).toBe(50);
    expect(deliveryReport.overall.successRate).toBe(50);
    expect(deliveryReport.overall.total).toBe(4);
    expect(dashboard.deliveryStats.successRate).toBe(stats.successRate);

    // « Nouveaux clients » — C1 (imported long ago, first order now), C3, C6; not C2 (ordered last year).
    expect(dashboard.newCustomersThisPeriod).toBe(3);
    expect(customers.totals.newCustomers).toBe(3);

    // « Remboursé » — the completed refunds of the period's orders.
    expect(overview.refundedAmount).toBe(50);
    expect(cash.inflows.refunded).toBe(50);
  });

  it("a recorded Retour / Remboursée wins over a « Livré » parcel on /livraison + dashboard, like /rapports/livraison", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const provider = await prisma.shippingProvider.create({ data: { name: "Livreur", type: "MANUEL" } });
    const customer = await prisma.customer.create({ data: { fullName: "Client" } });
    const now = Date.now();
    async function shipped(status: OrderStatus, parcel: ShipmentStatus) {
      const o = await prisma.order.create({
        data: { customerId: customer.id, status, subtotal: 100, total: 100, placedAt: new Date(now - 120_000), shippedAt: new Date(now - 100_000) },
      });
      await prisma.shipment.create({ data: { orderId: o.id, providerId: provider.id, status: parcel, createdAt: new Date(now - 90_000) } });
    }
    await shipped("LIVREE", "LIVRE"); // delivered
    await shipped("RETOUR", "LIVRE"); // delivered, then sent back → returned
    await shipped("REMBOURSEE", "LIVRE"); // delivered, then refunded → returned
    await shipped("EXPEDIEE", "ECHEC"); // failed
    await shipped("EXPEDIEE", "EN_TRANSIT"); // no outcome yet

    const range = { from: new Date(now - 3_600_000), to: new Date(now + 3_600_000) };
    const stats = await getDeliveryStats(range.from, range.to);
    const report = await getDeliveryPerformanceReport(range);
    expect(stats).toMatchObject({ total: 5, delivered: 1, failed: 1, returned: 2, inTransit: 1 });
    expect(report.overall).toMatchObject({ total: 5, delivered: 1, failed: 1, returned: 2, inTransit: 1 });
    expect(asPct(stats.successRate)).toBe(25);
    expect(report.overall.successRate).toBe(25);
  });

  it("« Stock faible »: dashboard count == /stock low filter == the low-stock alert decision (available stock, active locations)", async () => {
    await loginAsTestUser({ role: "OWNER" }); // global location access: receives every alert
    const active = await prisma.warehouse.create({ data: { name: "Actif", isDefault: true } });
    const inactive = await prisma.warehouse.create({ data: { name: "Fermé", isActive: false } });
    const product = (name: string) =>
      prisma.product.create({ data: { name, sku: `SKU-${name}-${Math.random()}`, price: 100, status: "ACTIF", lowStockThreshold: 5 } });
    const item = (warehouseId: string, productId: string, quantityOnHand: number, quantityReserved = 0) =>
      prisma.inventoryItem.create({ data: { warehouseId, productId, quantityOnHand, quantityReserved } });

    const reserved = await product("reserved"); // 8 on hand, 4 reserved → 4 available ≤ 5: LOW (on-hand alone says OK)
    const allReserved = await product("all-reserved"); // 2 on hand, 2 reserved → 0 available: LOW + RUPTURE
    const healthy = await product("healthy"); // 10 available: OK
    const closed = await product("closed"); // 1 on hand but at an INACTIVE location: left out everywhere
    const lowItem = await item(active.id, reserved.id, 8, 4);
    const outItem = await item(active.id, allReserved.id, 2, 2);
    await item(active.id, healthy.id, 10);
    await item(inactive.id, closed.id, 1);

    const dashboard = await getDashboardData("mois");
    const count = await getLowStockCount();
    const lowList = await listInventoryItems({ stockStatus: "low" });
    const outList = await listInventoryItems({ stockStatus: "out" });
    expect(count).toBe(2);
    expect(dashboard.lowStockCount).toBe(2);
    expect(lowList.total).toBe(2);
    expect(lowList.items.map((i) => i.id).sort()).toEqual([lowItem.id, outItem.id].sort());
    expect(outList.items.map((i) => i.id)).toEqual([outItem.id]);

    await checkAndNotifyLowStock({ productIds: [reserved.id, allReserved.id, healthy.id, closed.id] });
    const alerts = await prisma.notification.findMany({ where: { entityType: "InventoryItem" }, select: { type: true, entityId: true } });
    const alerted = new Map(alerts.map((a) => [a.entityId, a.type]));
    expect([...alerted.keys()].sort()).toEqual(lowList.items.map((i) => i.id).sort());
    expect(alerted.get(lowItem.id)).toBe("STOCK_FAIBLE");
    expect(alerted.get(outItem.id)).toBe("RUPTURE_STOCK");
  });
});
