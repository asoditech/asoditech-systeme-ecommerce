import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createExpenseAction } from "@/actions/finance";
import { getFinanceSummary } from "@/lib/queries/finance";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe("createExpenseAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("rejects a caller without finance.manage permission", async () => {
    const category = await prisma.expenseCategory.create({ data: { name: "Publicité" } });
    await loginAsTestUser({ role: "SALES" });
    await expect(
      createExpenseAction(
        formData({ categoryId: category.id, amount: "100", date: "2026-08-01", currency: "MAD" })
      )
    ).rejects.toThrow(/non autorisé/i);
  });

  it("records who recorded the expense and an audit event", async () => {
    const category = await prisma.expenseCategory.create({ data: { name: "Publicité" } });
    const user = await loginAsTestUser({ role: "ACCOUNTANT" });

    const result = await createExpenseAction(
      formData({ categoryId: category.id, amount: "500", date: "2026-08-01", currency: "MAD" })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expense = await prisma.expense.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(expense.recordedById).toBe(user.id);
    expect(expense.amount.toString()).toBe("500");
  });
});

describe("getFinanceSummary — data integrity", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("reports COGS as null (not zero) when no orders exist, rather than fabricating a figure", async () => {
    const summary = await getFinanceSummary({ from: new Date("2026-01-01"), to: new Date("2026-12-31") });
    expect(summary.cogs).toBeNull();
    expect(summary.cogsComplete).toBe(false);
    expect(summary.netProfit).toBeNull();
  });

  it("computes revenue only from non-cancelled orders", async () => {
    const customer = await prisma.customer.create({ data: { fullName: "Amine" } });
    const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt", isDefault: true } });
    const product = await prisma.product.create({ data: { name: "P", sku: "SKU-FIN-1", price: 100, cost: 40 } });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 10 } });

    await prisma.order.create({
      data: {
        customerId: customer.id,
        status: "LIVREE",
        subtotal: 100,
        total: 100,
        currency: "MAD",
        items: {
          create: [{ productId: product.id, nameSnapshot: "P", skuSnapshot: "SKU-FIN-1", unitPrice: 100, quantity: 1, total: 100, costSnapshot: 40 }],
        },
      },
    });
    await prisma.order.create({
      data: {
        customerId: customer.id,
        status: "ANNULEE",
        subtotal: 999,
        total: 999,
        currency: "MAD",
      },
    });

    const summary = await getFinanceSummary({ from: new Date("2020-01-01"), to: new Date("2030-01-01") });
    expect(summary.revenue).toBe(100);
    expect(summary.ordersCount).toBe(1);
    expect(summary.cogs).toBe(40);
    expect(summary.grossProfit).toBe(60);
  });
});
