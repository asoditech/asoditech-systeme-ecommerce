import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  computeOrderProfit,
  computePeriodProfitability,
  computeProductProfitability,
  unitEconomics,
} from "@/lib/profitability";
import { resetDb } from "../helpers/db";

const PERIOD = { from: new Date("2020-01-01"), to: new Date("2030-01-01") };

async function seedSoldOrder(opts: {
  status?: string;
  price: number;
  cost: number | null;
  qty?: number;
  placedAt?: Date;
  shipmentCost?: number;
  shipmentStatus?: string;
  shipmentCostSource?: string;
  refund?: number;
}) {
  const customer = await prisma.customer.create({ data: { fullName: "C" } });
  const product = await prisma.product.create({
    data: { name: "P", sku: `S-${Math.random()}`, price: opts.price, cost: opts.cost, status: "ACTIF" },
  });
  const qty = opts.qty ?? 1;
  const order = await prisma.order.create({
    data: {
      customerId: customer.id,
      status: (opts.status ?? "LIVREE") as never,
      subtotal: opts.price * qty,
      total: opts.price * qty,
      currency: "MAD",
      placedAt: opts.placedAt ?? new Date("2026-06-15"),
      items: {
        create: {
          productId: product.id,
          nameSnapshot: "P",
          skuSnapshot: "S",
          unitPrice: opts.price,
          quantity: qty,
          total: opts.price * qty,
          costSnapshot: opts.cost,
        },
      },
    },
    include: { items: true },
  });
  if (opts.shipmentCost !== undefined) {
    const provider = await prisma.shippingProvider.create({ data: { name: "X", type: "MANUEL" } });
    await prisma.shipment.create({
      data: {
        orderId: order.id,
        providerId: provider.id,
        cost: opts.shipmentCost,
        ...(opts.shipmentStatus ? { status: opts.shipmentStatus as never } : {}),
        ...(opts.shipmentCostSource ? { costSource: opts.shipmentCostSource as never } : {}),
      },
    });
  }
  if (opts.refund !== undefined) {
    await prisma.refund.create({ data: { orderId: order.id, amount: opts.refund, status: "COMPLETE" } });
  }
  return { order, product };
}

describe("computeOrderProfit", () => {
  it("computes gross profit and margin from the cost snapshot", () => {
    const p = computeOrderProfit({
      status: "LIVREE",
      total: 150,
      items: [{ costSnapshot: 70, quantity: 1 }],
    });
    expect(p.revenue).toBe(150);
    expect(p.cogs).toBe(70);
    expect(p.grossProfit).toBe(80);
    expect(p.grossMarginPct).toBe(53.3);
  });

  it("reports COGS incomplete when a line has no cost snapshot", () => {
    const p = computeOrderProfit({
      status: "LIVREE",
      total: 150,
      items: [{ costSnapshot: 70, quantity: 1 }, { costSnapshot: null, quantity: 2 }],
    });
    expect(p.cogsComplete).toBe(false);
    expect(p.cogs).toBeNull();
    expect(p.grossProfit).toBeNull();
    expect(p.itemsMissingCost).toBe(1);
  });

  it("does not count a returned order", () => {
    const p = computeOrderProfit({ status: "RETOUR", total: 150, items: [{ costSnapshot: 70, quantity: 1 }] });
    expect(p.counted).toBe(false);
    expect(p.revenue).toBe(0);
    expect(p.grossProfit).toBeNull();
  });

  it("nets a completed refund out of revenue", () => {
    const p = computeOrderProfit({
      status: "LIVREE",
      total: 200,
      items: [{ costSnapshot: 60, quantity: 1 }],
      refunds: [{ amount: 50, status: "COMPLETE" }, { amount: 30, status: "EN_ATTENTE" }],
    });
    expect(p.revenue).toBe(150); // 200 − 50 completed
    expect(p.grossProfit).toBe(90);
  });

  it("subtracts delivery cost for profit-after-delivery", () => {
    const p = computeOrderProfit({
      status: "LIVREE",
      total: 100,
      items: [{ costSnapshot: 40, quantity: 1 }],
      shipments: [{ cost: 25 }],
    });
    expect(p.grossProfit).toBe(60);
    expect(p.deliveryCost).toBe(25);
    expect(p.profitAfterDelivery).toBe(35);
  });

  // Client feedback #3: a parcel that never completed a delivery service —
  // because the order was cancelled before it reached the customer, or the
  // shipment itself was cancelled — must not create a delivery deduction.
  it("does not deduct delivery cost for a cancelled order", () => {
    const p = computeOrderProfit({
      status: "ANNULEE",
      total: 100,
      items: [{ costSnapshot: 40, quantity: 1 }],
      shipments: [{ cost: 25 }],
    });
    expect(p.deliveryCost).toBe(0);
  });

  it("does not deduct the cost of a cancelled shipment on a live order", () => {
    const p = computeOrderProfit({
      status: "LIVREE",
      total: 100,
      items: [{ costSnapshot: 40, quantity: 1 }],
      shipments: [{ cost: 25, status: "ANNULE" }, { cost: 30, status: "LIVRE" }],
    });
    expect(p.deliveryCost).toBe(30);
    expect(p.profitAfterDelivery).toBe(30); // 60 gross − 30 delivered parcel
  });

  it("is decimal-safe (no float drift)", () => {
    const p = computeOrderProfit({
      status: "LIVREE",
      total: "0.3",
      items: [{ costSnapshot: "0.1", quantity: 2 }],
    });
    expect(p.cogs).toBe(0.2);
    expect(p.grossProfit).toBe(0.1);
  });
});

describe("computePeriodProfitability", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("counts only non-excluded orders and computes margins", async () => {
    await seedSoldOrder({ price: 200, cost: 80, status: "LIVREE" });
    await seedSoldOrder({ price: 999, cost: 500, status: "ANNULEE" });
    await seedSoldOrder({ price: 999, cost: 500, status: "RETOUR" });

    const p = await computePeriodProfitability(PERIOD);
    expect(p.ordersCount).toBe(1);
    expect(p.revenue).toBe(200);
    expect(p.cogs).toBe(80);
    expect(p.grossProfit).toBe(120);
    expect(p.grossMarginPct).toBe(60);
  });

  it("splits advertising out of expenses and folds it into net profit", async () => {
    await seedSoldOrder({ price: 300, cost: 100, status: "LIVREE" });
    const ads = await prisma.expenseCategory.create({ data: { name: "Publicité" } });
    const rent = await prisma.expenseCategory.create({ data: { name: "Loyer" } });
    await prisma.expense.create({ data: { categoryId: ads.id, amount: 50, date: new Date("2026-06-10"), currency: "MAD" } });
    await prisma.expense.create({ data: { categoryId: rent.id, amount: 30, date: new Date("2026-06-10"), currency: "MAD" } });

    const p = await computePeriodProfitability(PERIOD);
    expect(p.advertisingCost).toBe(50);
    expect(p.otherExpensesTotal).toBe(30);
    expect(p.expensesTotal).toBe(80);
    expect(p.grossProfit).toBe(200);
    expect(p.netProfit).toBe(120); // 200 − 80 expenses − 0 delivery
  });

  // Client feedback #3, at the period level: a cancelled order's in-flight
  // carrier estimate was being deducted from net profit. A RETOUR order's
  // return-rule charge is a separate concern and stays counted.
  it("excludes a cancelled order's shipment cost but keeps a return-rule charge", async () => {
    await seedSoldOrder({ price: 300, cost: 100, status: "LIVREE", shipmentCost: 20 });
    await seedSoldOrder({ price: 999, cost: 500, status: "ANNULEE", shipmentCost: 40 });
    await seedSoldOrder({
      price: 999,
      cost: 500,
      status: "RETOUR",
      shipmentCost: 15,
      shipmentStatus: "RETOURNE",
      shipmentCostSource: "RETURN_RULE",
    });

    const p = await computePeriodProfitability(PERIOD);
    // 20 (delivered order) + 15 (return-rule) — never the 40 cancelled one.
    expect(p.deliveryCostTotal).toBe(35);
    expect(p.returnCostTotal).toBe(15);
    expect(p.carrierDeliveryCost).toBe(20);
  });

  it("reports incomplete COGS rather than a false profit", async () => {
    await seedSoldOrder({ price: 300, cost: null, status: "LIVREE" });
    const p = await computePeriodProfitability(PERIOD);
    expect(p.cogsComplete).toBe(false);
    expect(p.cogs).toBeNull();
    expect(p.grossProfit).toBeNull();
    expect(p.netProfit).toBeNull();
    expect(p.itemsMissingCost).toBe(1);
  });
});

describe("computeProductProfitability", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("groups by product, flags missing cost, and sorts by profit", async () => {
    const { product: winner } = await seedSoldOrder({ price: 500, cost: 100, qty: 2, status: "LIVREE" });
    await seedSoldOrder({ price: 100, cost: 90, status: "LIVREE" });
    await seedSoldOrder({ price: 100, cost: null, status: "LIVREE" });

    const rows = await computeProductProfitability(PERIOD);
    expect(rows[0].productId).toBe(winner.id);
    expect(rows[0].grossProfit).toBe(800); // (500−100)*2
    expect(rows[0].marginPct).toBe(80);
    expect(rows.some((r) => r.grossProfit === null && !r.cogsComplete)).toBe(true);
  });

  it("historical product profit does not move when Product.cost changes later", async () => {
    const { product } = await seedSoldOrder({ price: 150, cost: 70, status: "LIVREE" });
    const before = (await computeProductProfitability(PERIOD)).find((r) => r.productId === product.id);
    expect(before?.grossProfit).toBe(80);

    await prisma.product.update({ where: { id: product.id }, data: { cost: 200 } });
    const after = (await computeProductProfitability(PERIOD)).find((r) => r.productId === product.id);
    expect(after?.grossProfit).toBe(80); // costSnapshot unchanged
  });
});

describe("unitEconomics", () => {
  it("returns forward-looking margin at current price/cost", () => {
    expect(unitEconomics(150, 70)).toEqual({ unitCost: 70, unitMargin: 80, unitMarginPct: 53.3 });
  });
  it("is null when cost is unknown", () => {
    expect(unitEconomics(150, null)).toEqual({ unitCost: null, unitMargin: null, unitMarginPct: null });
  });
});
