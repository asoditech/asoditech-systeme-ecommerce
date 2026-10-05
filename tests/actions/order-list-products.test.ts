import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prismaBase } from "@/lib/prisma";
import { listOrders } from "@/lib/queries/orders";
import { listSales } from "@/lib/queries/sales";
import { getCurrentUser } from "@/lib/auth/session";
import { productChips } from "@/lib/catalog/product-chips";
import { resetDb, setTestBusinessMode, DEFAULT_TENANT_ID } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/** « Produits » column: both list queries carry each line's name, quantity and variation options. */

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

async function seedCatalog() {
  const t = DEFAULT_TENANT_ID;
  const basket = await prismaBase.product.create({ data: { tenantId: t, name: "Basket", sku: "B-1", price: 300 } });
  const rouge = await prismaBase.productVariation.create({
    data: { tenantId: t, productId: basket.id, sku: "B-1-R", attributes: { Couleur: "Rouge" }, price: 300 },
  });
  const cap = await prismaBase.product.create({ data: { tenantId: t, name: "Casquette", sku: "C-1", price: 80 } });
  return { basket, rouge, cap };
}

describe("« Produits » data on the lists", () => {
  it("online orders", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { basket, rouge, cap } = await seedCatalog();
    const customer = await prismaBase.customer.create({ data: { tenantId: DEFAULT_TENANT_ID, fullName: "Sara" } });
    await prismaBase.order.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        customerId: customer.id,
        subtotal: 680,
        total: 680,
        items: {
          create: [
            { tenantId: DEFAULT_TENANT_ID, productId: basket.id, variationId: rouge.id, nameSnapshot: "Basket", skuSnapshot: "B-1-R", unitPrice: 300, quantity: 2, total: 600 },
            { tenantId: DEFAULT_TENANT_ID, productId: cap.id, nameSnapshot: "Casquette", skuSnapshot: "C-1", unitPrice: 80, quantity: 1, total: 80 },
          ],
        },
      },
    });
    const { orders } = await listOrders({});
    const { chips } = productChips(orders[0].items.map((i) => ({ name: i.nameSnapshot, quantity: i.quantity, attributes: i.variation?.attributes })));
    expect(chips).toEqual(
      expect.arrayContaining([
        { label: "Basket — Rouge", quantity: 2 },
        { label: "Casquette", quantity: 1 },
      ])
    );
  });

  it("offline sales", async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    await loginAsTestUser({ role: "ADMIN" });
    const { basket, rouge } = await seedCatalog();
    const store = await prismaBase.salesChannel.create({ data: { tenantId: DEFAULT_TENANT_ID, name: "Magasin", kind: "OFFLINE" } });
    const wh = await prismaBase.warehouse.create({ data: { tenantId: DEFAULT_TENANT_ID, name: "Boutique" } });
    await prismaBase.sale.create({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        salesChannelId: store.id,
        warehouseId: wh.id,
        idempotencyKey: "k-prod-1",
        subtotal: 300,
        total: 300,
        lines: {
          create: [{ tenantId: DEFAULT_TENANT_ID, productId: basket.id, variationId: rouge.id, nameSnapshot: "Basket", skuSnapshot: "B-1-R", unitPrice: 300, quantity: 1, total: 300 }],
        },
      },
    });
    const { sales } = await listSales((await getCurrentUser())!, {});
    const { chips } = productChips(sales[0].lines.map((l) => ({ name: l.nameSnapshot, quantity: l.quantity, attributes: l.variation?.attributes })));
    expect(chips).toEqual([{ label: "Basket — Rouge", quantity: 1 }]);
  });
});
