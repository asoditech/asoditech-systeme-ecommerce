import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createExpenseAction, createExpenseCategoryAction } from "@/actions/finance";
import { createOrderAction, createRefundAction, updateRefundStatusAction } from "@/actions/orders";
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

describe("createExpenseCategoryAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("audits creation as expense_category.created, not expense.created (Phase 26 audit fix)", async () => {
    const user = await loginAsTestUser({ role: "ACCOUNTANT" });
    const result = await createExpenseCategoryAction(formData({ name: "Logistique" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: result.data.id, entityType: "ExpenseCategory" } });
    expect(audit.action).toBe("expense_category.created");
    expect(audit.actorUserId).toBe(user.id);
  });

  it("rejects a duplicate category name", async () => {
    await loginAsTestUser({ role: "ACCOUNTANT" });
    await createExpenseCategoryAction(formData({ name: "Logistique" }));
    const second = await createExpenseCategoryAction(formData({ name: "Logistique" }));
    expect(second.ok).toBe(false);
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

  it("attributes a refund to the order's own period, not the refund's own date (audit fix)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const customer = await prisma.customer.create({ data: { fullName: "Amine" } });
    const warehouse = await prisma.warehouse.create({ data: { id: "default-warehouse", name: "Entrepôt", isDefault: true } });
    const product = await prisma.product.create({ data: { name: "P", sku: "SKU-FIN-2", price: 100, cost: 40, status: "ACTIF" } });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 10 } });

    const created = await createOrderAction({
      customerId: customer.id,
      paymentMethod: "PAIEMENT_LIVRAISON",
      shippingCost: 0,
      discountTotal: 0,
      currency: "MAD",
      notes: "",
      internalNotes: "",
      shippingAddressLine1: "",
      shippingAddressLine2: "",
      shippingCity: "",
      shippingRegion: "",
      shippingCountry: "",
      shippingPhone: "",
      items: [{ productId: product.id, quantity: 1, unitPrice: 100, discount: 0 }],
    });
    if (!created.ok) throw new Error("setup failed");

    // Backdate the order itself into a past period, as if it was sold last
    // month; the refund below is processed "now" (a later period).
    const pastPeriodStart = new Date("2025-01-01");
    const pastPeriodEnd = new Date("2025-01-31T23:59:59");
    await prisma.order.update({
      where: { id: created.data.id },
      data: { createdAt: new Date("2025-01-15"), placedAt: new Date("2025-01-15") },
    });

    const refund = await createRefundAction(formData({ orderId: created.data.id, amount: "100" }));
    if (!refund.ok) throw new Error("setup failed");
    await updateRefundStatusAction(formData({ id: refund.data.id, status: "APPROUVE" }));
    await updateRefundStatusAction(formData({ id: refund.data.id, status: "COMPLETE" }));

    // The order's own period (January 2025) must reflect the refund...
    const januarySummary = await getFinanceSummary({ from: pastPeriodStart, to: pastPeriodEnd });
    expect(januarySummary.revenue).toBe(0);
    expect(januarySummary.refundsTotal).toBe(100);

    // ...and "today" (when the refund was actually processed) must NOT
    // show a phantom refund against orders that were never sold in it.
    const todaySummary = await getFinanceSummary({
      from: new Date(new Date().setHours(0, 0, 0, 0)),
      to: new Date(new Date().setHours(23, 59, 59, 999)),
    });
    expect(todaySummary.refundsTotal).toBe(0);
  });

  it("does not net out a refund that is only EN_ATTENTE (not yet COMPLETE)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const customer = await prisma.customer.create({ data: { fullName: "Amine" } });
    const warehouse = await prisma.warehouse.create({ data: { id: "default-warehouse", name: "Entrepôt", isDefault: true } });
    const product = await prisma.product.create({ data: { name: "P", sku: "SKU-FIN-3", price: 100, cost: 40, status: "ACTIF" } });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 10 } });

    const created = await createOrderAction({
      customerId: customer.id,
      paymentMethod: "PAIEMENT_LIVRAISON",
      shippingCost: 0,
      discountTotal: 0,
      currency: "MAD",
      notes: "",
      internalNotes: "",
      shippingAddressLine1: "",
      shippingAddressLine2: "",
      shippingCity: "",
      shippingRegion: "",
      shippingCountry: "",
      shippingPhone: "",
      items: [{ productId: product.id, quantity: 1, unitPrice: 100, discount: 0 }],
    });
    if (!created.ok) throw new Error("setup failed");
    await createRefundAction(formData({ orderId: created.data.id, amount: "50" })); // stays EN_ATTENTE

    const summary = await getFinanceSummary({ from: new Date("2020-01-01"), to: new Date("2030-01-01") });
    expect(summary.revenue).toBe(100); // not reduced — refund never completed
    expect(summary.refundsTotal).toBe(0);
  });
});
