import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { listOrders } from "@/lib/queries/orders";
import { resetDb } from "../helpers/db";

/**
 * Regression: the /commandes filter form submits the sentinel "all" for
 * "Tous les statuts" / "Tous les paiements", and a bare `type="date"`
 * input can arrive as "". None of those must reach Prisma as a filter
 * value — before this guard, `status: "all"` crashed the whole page.
 */
async function seedOrder(overrides: Partial<{ status: "NOUVELLE" | "LIVREE"; total: number }> = {}) {
  const customer = await prisma.customer.create({ data: { fullName: "Client Test" } });
  const total = overrides.total ?? 100;
  return prisma.order.create({
    data: {
      customerId: customer.id,
      status: overrides.status ?? "NOUVELLE",
      subtotal: total,
      total,
      currency: "MAD",
    },
  });
}

describe("listOrders — hardening against filter-form query strings", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("ignores non-date dateFrom/dateTo values instead of throwing", async () => {
    await seedOrder();
    const result = await listOrders({ dateFrom: "all", dateTo: "not-a-date" });
    expect(result.total).toBe(1);
  });

  it("ignores empty-string date and total filters", async () => {
    await seedOrder();
    const result = await listOrders({ dateFrom: "", dateTo: "", minTotal: "", maxTotal: "" });
    expect(result.total).toBe(1);
  });

  it("still applies a real date range (on placedAt, not import time)", async () => {
    const old = await seedOrder();
    await prisma.order.update({ where: { id: old.id }, data: { placedAt: new Date("2020-01-01") } });
    await seedOrder();

    const thisYear = await listOrders({ dateFrom: `${new Date().getFullYear()}-01-01` });
    expect(thisYear.total).toBe(1);
  });

  it("ignores a non-numeric total filter", async () => {
    await seedOrder({ total: 100 });
    const result = await listOrders({ minTotal: "abc" });
    expect(result.total).toBe(1);
  });
});
