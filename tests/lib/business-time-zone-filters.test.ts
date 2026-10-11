import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prismaBase } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { listOrders } from "@/lib/queries/orders";
import { listExpenses } from "@/lib/queries/finance";
import { getBusinessTimeZone } from "@/lib/time/business-zone";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";

/**
 * S2 — the « Du / Au » filters of /commandes and /depenses are whole days of
 * the TENANT's « Fuseau horaire » (BusinessSettings.timezone), both ends
 * inclusive — the historical code read the start as UTC midnight and the
 * end as server-local 23:59:59.
 */
const A = DEFAULT_TENANT_ID;
const B = "tenant-b-time-zone";
const inTenant = <T,>(tenantId: string, fn: () => Promise<T>) => runWithTenant(tenantId, "test:time-zone", fn);

async function order(tenantId: string, placedAt: string) {
  const customer = await prismaBase.customer.create({ data: { tenantId, fullName: "Client" } });
  return prismaBase.order.create({
    data: { tenantId, customerId: customer.id, subtotal: 100, total: 100, status: "NOUVELLE", placedAt: new Date(placedAt) },
  });
}

beforeEach(resetDb);
afterEach(resetDb);

describe("business time zone — order and expense day filters", () => {
  it("defaults to Africa/Casablanca, follows the tenant's setting, ignores an invalid one, and stays per tenant", async () => {
    await prismaBase.tenant.create({ data: { id: B, name: "B", slug: B } });
    expect(await inTenant(A, getBusinessTimeZone)).toBe("Africa/Casablanca"); // no settings row
    await prismaBase.businessSettings.create({ data: { tenantId: A, timezone: "Europe/Paris" } });
    await prismaBase.businessSettings.create({ data: { tenantId: B, timezone: "Not/AZone" } });
    expect(await inTenant(A, getBusinessTimeZone)).toBe("Europe/Paris");
    expect(await inTenant(B, getBusinessTimeZone)).toBe("Africa/Casablanca");
  });

  it("/commandes « 10 octobre » = the Moroccan 10th: 00:30 is in, 23:30 the evening before is out, 23:59 is in", async () => {
    const lateOn9 = await order(A, "2026-10-09T22:30:00Z"); // 23:30 on the 9th in Casablanca
    const earlyOn10 = await order(A, "2026-10-09T23:30:00Z"); // 00:30 on the 10th
    const lastMinuteOn10 = await order(A, "2026-10-10T22:59:59Z"); // 23:59:59 on the 10th
    const on11 = await order(A, "2026-10-10T23:00:00Z"); // 00:00 on the 11th

    const ids = async () => (await inTenant(A, () => listOrders({ dateFrom: "2026-10-10", dateTo: "2026-10-10" }))).orders.map((o) => o.id).sort();
    expect(await ids()).toEqual([earlyOn10.id, lastMinuteOn10.id].sort());

    // Same filter, tenant set to UTC → UTC days.
    await prismaBase.businessSettings.create({ data: { tenantId: A, timezone: "UTC" } });
    expect(await ids()).toEqual([lastMinuteOn10.id, on11.id].sort());
    expect((await ids()).includes(lateOn9.id)).toBe(false);
  });

  it("an invalid day value never reaches Prisma (no filter rather than a crash)", async () => {
    await order(A, "2026-10-09T23:30:00Z");
    const res = await inTenant(A, () => listOrders({ dateFrom: "all", dateTo: "2026-02-31" }));
    expect(res.total).toBe(1);
  });

  it("/depenses uses the same Moroccan days", async () => {
    const category = await prismaBase.expenseCategory.create({ data: { tenantId: A, name: "Divers" } });
    const mk = (date: string) =>
      prismaBase.expense.create({ data: { tenantId: A, categoryId: category.id, description: date, amount: 10, date: new Date(date) } });
    await mk("2026-10-09T22:30:00Z"); // 9th in Casablanca
    const inside = await mk("2026-10-09T23:30:00Z"); // 10th
    const res = await inTenant(A, () => listExpenses({ dateFrom: "2026-10-10", dateTo: "2026-10-10" }));
    expect(res.expenses.map((e) => e.id)).toEqual([inside.id]);
  });
});
