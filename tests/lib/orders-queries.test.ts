import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { listOrders, getOrderDetail } from "@/lib/queries/orders";
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

/**
 * Client feedback #4: the order-detail items table links each product name
 * to its product page. The order query must expose a product id per line —
 * directly (`productId`) for a simple product, or via the variation
 * (`variation.productId`) for a variable one — and leave it null when the
 * product was deleted so the name renders as plain text.
 */
describe("getOrderDetail — product id per line for the item link", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("resolves a product id directly and through a variation, null when deleted", async () => {
    const customer = await prisma.customer.create({ data: { fullName: "Client Test" } });
    const simple = await prisma.product.create({
      data: { name: "Simple", sku: `S-${Math.random()}`, price: 100, status: "ACTIF" },
    });
    const variable = await prisma.product.create({
      data: { name: "Variable", sku: `V-${Math.random()}`, price: 0, status: "ACTIF" },
    });
    const variation = await prisma.productVariation.create({
      data: { productId: variable.id, sku: `VAR-${Math.random()}`, price: 120, attributes: { Couleur: "Rouge" } },
    });

    const order = await prisma.order.create({
      data: {
        customerId: customer.id,
        status: "NOUVELLE",
        subtotal: 340,
        total: 340,
        currency: "MAD",
        items: {
          create: [
            { productId: simple.id, nameSnapshot: "Simple", skuSnapshot: "S", unitPrice: 100, quantity: 1, total: 100 },
            { productId: variable.id, variationId: variation.id, nameSnapshot: "Variable", skuSnapshot: "VAR", unitPrice: 120, quantity: 1, total: 120 },
            { productId: null, nameSnapshot: "Produit supprimé", skuSnapshot: "X", unitPrice: 120, quantity: 1, total: 120 },
          ],
        },
      },
    });

    const detail = await getOrderDetail(order.id);
    const byName = Object.fromEntries(
      (detail!.items ?? []).map((i) => [i.nameSnapshot, i.productId ?? i.variation?.productId ?? null])
    );
    expect(byName["Simple"]).toBe(simple.id);
    expect(byName["Variable"]).toBe(variable.id);
    expect(byName["Produit supprimé"]).toBeNull();
  });
});
