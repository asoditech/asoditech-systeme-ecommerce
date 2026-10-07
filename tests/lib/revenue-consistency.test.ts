import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OrderStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getRevenueTrend } from "@/lib/queries/dashboard";
import { getTopProducts, getTopSellingUnits } from "@/lib/queries/analytics";
import { getProductProfitStats, getProductSalesStats } from "@/lib/queries/products";
import { getCustomerStats } from "@/lib/queries/customers";
import { toolTopProductsToday } from "@/lib/ai/tools";
import { REVENUE_EXCLUDED_STATUSES } from "@/lib/profitability";
import { resetDb } from "../helpers/db";

/**
 * Every revenue / sales metric uses the profitability rule
 * (REVENUE_EXCLUDED_STATUSES): ANNULEE, ECHEC, RETOUR and REMBOURSEE never
 * count as realised sales. Operational counts (orders, returned, cancelled)
 * keep their own definitions.
 */

// status → [order total, quantity of the single line]
const ORDERS: [OrderStatus, number, number][] = [
  ["LIVREE", 100, 1],
  ["EXPEDIEE", 50, 2],
  ["RETOUR", 200, 3],
  ["REMBOURSEE", 300, 4],
  ["ANNULEE", 400, 5],
  ["ECHEC", 500, 6],
];
const REALISED_REVENUE = 150; // LIVREE + EXPEDIEE
const REALISED_UNITS = 3;

async function seed() {
  const customer = await prisma.customer.create({ data: { fullName: "Client Test" } });
  const product = await prisma.product.create({
    data: { name: "Produit CA", sku: `CA-${Math.random()}`, price: 50, status: "ACTIF" },
  });
  const placedAt = new Date();
  for (const [status, total, quantity] of ORDERS) {
    await prisma.order.create({
      data: {
        customerId: customer.id,
        status,
        subtotal: total,
        total,
        currency: "MAD",
        placedAt,
        items: {
          create: {
            productId: product.id,
            nameSnapshot: "Produit CA",
            skuSnapshot: "CA",
            unitPrice: total / quantity,
            quantity,
            total,
            costSnapshot: 10,
          },
        },
      },
    });
  }
  return { customer, product, placedAt };
}

describe("revenue / sales metrics — REVENUE_EXCLUDED_STATUSES everywhere", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("uses the profitability rule (ANNULEE, ECHEC, RETOUR, REMBOURSEE)", () => {
    expect([...REVENUE_EXCLUDED_STATUSES].sort()).toEqual(["ANNULEE", "ECHEC", "REMBOURSEE", "RETOUR"]);
  });

  it("dashboard revenue trend excludes RETOUR and REMBOURSEE", async () => {
    const { placedAt } = await seed();
    const trend = await getRevenueTrend("annee");
    const bucket = trend.find((b) => b.key === `${placedAt.getFullYear()}-${placedAt.getMonth()}`);
    expect(bucket?.revenue).toBe(REALISED_REVENUE);
    expect(trend.reduce((s, b) => s + b.revenue, 0)).toBe(REALISED_REVENUE);
  });

  it("top products and top selling units count only realised sales", async () => {
    const { product, placedAt } = await seed();
    const [top] = await getTopProducts(5);
    expect(top.product?.id).toBe(product.id);
    expect(top.unitsSold).toBe(REALISED_UNITS);
    expect(Number(top.revenue)).toBe(REALISED_REVENUE);

    const [unit] = await getTopSellingUnits({ from: new Date(placedAt.getTime() - 60_000), to: new Date(placedAt.getTime() + 60_000) });
    expect(unit.unitsSold).toBe(REALISED_UNITS);
    expect(unit.revenue).toBe(REALISED_REVENUE);
  });

  it("product sales statistics match the product profitability figures", async () => {
    const { product } = await seed();
    const sales = await getProductSalesStats(product.id);
    expect(sales.unitsSold).toBe(REALISED_UNITS);
    expect(Number(sales.revenue)).toBe(REALISED_REVENUE);

    const profit = await getProductProfitStats(product.id);
    expect(profit.unitsSold).toBe(sales.unitsSold);
    expect(profit.revenue).toBe(Number(sales.revenue));
  });

  it("customer spend excludes RETOUR and REMBOURSEE; operational counts are unchanged", async () => {
    const { customer } = await seed();
    const stats = await getCustomerStats(customer.id);
    expect(Number(stats.totalSpent)).toBe(REALISED_REVENUE);
    expect(Number(stats.avgOrderValue)).toBe(REALISED_REVENUE / 2);
    // « Commandes » keeps its definition: everything but ANNULEE / ECHEC.
    expect(stats.ordersCount).toBe(4);
    expect(stats.returnedOrders).toBe(2);
    expect(stats.cancelledOrders).toBe(1);
  });

  it("customer with only returned/refunded orders has no spend but keeps its order count", async () => {
    const customer = await prisma.customer.create({ data: { fullName: "Client Retour" } });
    for (const status of ["RETOUR", "REMBOURSEE"] as const) {
      await prisma.order.create({
        data: { customerId: customer.id, status, subtotal: 80, total: 80, currency: "MAD", placedAt: new Date() },
      });
    }
    const stats = await getCustomerStats(customer.id);
    expect(stats.totalSpent).toBeNull();
    expect(stats.avgOrderValue).toBeNull();
    expect(stats.ordersCount).toBe(2);
    expect(stats.returnedOrders).toBe(2);
  });

  it("AI « produits les plus vendus aujourd'hui » counts only realised units", async () => {
    await seed();
    const answer = await toolTopProductsToday();
    expect(answer).toContain(`Produit CA (${REALISED_UNITS})`);
  });
});
