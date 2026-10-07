import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createSaleAction } from "@/actions/sales";
import { getFinanceSummary } from "@/lib/queries/finance";
import { getChannelReport } from "@/lib/queries/reports/channels";
import { getCurrentUser } from "@/lib/auth/session";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Finance scope — pins TODAY's semantics (audited, decision pending): the
 * Finance / profitability figures are built from ONLINE orders only; store
 * sales are reported by the channel report (En ligne / Magasin / Total) and
 * store analytics. Screens say so for tenants that sell in store. If store
 * sales are ever merged into finance, this test is the one to update.
 */

const range = () => ({ from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000) });

beforeEach(async () => {
  await resetDb();
  await setTestBusinessMode("ONLINE_AND_OFFLINE");
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

describe("finance vs store sales", () => {
  it("a store sale is not in the finance summary but is in the channel report total", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const store = await prisma.warehouse.create({ data: { name: "Magasin", type: "MAGASIN", isDefault: true } });
    const channel = await prisma.salesChannel.create({ data: { name: "Caisse", kind: "OFFLINE" } });
    await prisma.salesChannelLocation.create({ data: { salesChannelId: channel.id, warehouseId: store.id } });
    const product = await prisma.product.create({ data: { name: "Sac", sku: `S-${Math.random()}`, price: 180, cost: 100, status: "ACTIF" } });
    await prisma.productSalesChannel.create({ data: { productId: product.id, salesChannelId: channel.id } });
    await prisma.inventoryItem.create({ data: { warehouseId: store.id, productId: product.id, quantityOnHand: 5 } });
    const customer = await prisma.customer.create({ data: { fullName: "Client" } });
    await prisma.order.create({
      data: { customerId: customer.id, status: "LIVREE", subtotal: 300, total: 300, currency: "MAD", placedAt: new Date() },
    });
    const sale = await createSaleAction({
      salesChannelId: channel.id,
      warehouseId: store.id,
      idempotencyKey: randomUUID(),
      lines: [{ productId: product.id, quantity: 1 }],
      payments: [{ method: "ESPECES", amount: 180 }],
    });
    expect(sale.ok).toBe(true);

    const finance = await getFinanceSummary(range());
    expect(Number(finance.revenue)).toBe(300); // online orders only

    const report = await getChannelReport((await getCurrentUser())!, range());
    expect(report.online?.revenue).toBe(300);
    expect(report.offline?.netSales).toBe(180);
    expect(report.total?.revenue).toBe(480);
  });
});
