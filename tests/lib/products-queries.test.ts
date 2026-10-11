import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { listProducts, listCategoriesWithStats } from "@/lib/queries/products";
import { resetDb } from "../helpers/db";

/**
 * Client feedback #8: the products table shows a "Coût d'achat" ("prix
 * original") column to finance-facing roles. For a variable product the
 * column renders a cost range built from the variation costs, so the list
 * query must return `cost` on each variation.
 */
describe("listProducts — variation cost for the products table", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("returns each variation's purchase cost alongside its price", async () => {
    const product = await prisma.product.create({
      data: { name: "Coffret", sku: `V-${Math.random()}`, price: 0, status: "ACTIF" },
    });
    await prisma.productVariation.create({
      data: { productId: product.id, sku: `A-${Math.random()}`, price: 120, cost: 70, attributes: { Taille: "M" } },
    });
    await prisma.productVariation.create({
      data: { productId: product.id, sku: `B-${Math.random()}`, price: 150, cost: 90, attributes: { Taille: "L" } },
    });

    const { products } = await listProducts({});
    const row = products.find((p) => p.id === product.id)!;
    expect(row.variations.map((v) => Number(v.cost)).sort()).toEqual([70, 90]);
  });

  it("returns a simple product's own cost", async () => {
    await prisma.product.create({
      data: { name: "Simple", sku: `S-${Math.random()}`, price: 100, cost: 55, status: "ACTIF" },
    });
    const { products } = await listProducts({});
    expect(Number(products[0].cost)).toBe(55);
  });
});

// Batch 3, Task 1 — /catalogue/categories management page's read side.
describe("listCategoriesWithStats", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("counts products, sums variant counts and stock-on-hand across a category's products and variations", async () => {
    const warehouse = await prisma.warehouse.create({ data: { name: "Principal", isDefault: true } });
    const category = await prisma.category.create({ data: { name: "Chaussures", slug: "chaussures" } });

    // Simple product in the category: 1 product, 0 variants, 5 on hand.
    const simple = await prisma.product.create({
      data: { name: "Sandale", sku: `SA-${Math.random()}`, price: 100, status: "ACTIF", categoryId: category.id },
    });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: simple.id, quantityOnHand: 5 } });

    // Variable product in the category: 1 product, 2 variants, 3+4 on hand.
    const variable = await prisma.product.create({
      data: { name: "Basket", sku: `BA-${Math.random()}`, price: 200, status: "ACTIF", categoryId: category.id },
    });
    const v1 = await prisma.productVariation.create({
      data: { productId: variable.id, sku: `BA-1-${Math.random()}`, attributes: { Taille: "40" } },
    });
    const v2 = await prisma.productVariation.create({
      data: { productId: variable.id, sku: `BA-2-${Math.random()}`, attributes: { Taille: "42" } },
    });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, variationId: v1.id, quantityOnHand: 3 } });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, variationId: v2.id, quantityOnHand: 4 } });

    // A product in a DIFFERENT category must never leak into these totals.
    const other = await prisma.category.create({ data: { name: "Sacs", slug: "sacs" } });
    const outside = await prisma.product.create({
      data: { name: "Sac", sku: `SC-${Math.random()}`, price: 50, status: "ACTIF", categoryId: other.id },
    });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: outside.id, quantityOnHand: 999 } });

    const rows = await listCategoriesWithStats();
    const row = rows.find((r) => r.id === category.id)!;
    expect(row.productCount).toBe(2);
    expect(row.variantCount).toBe(2);
    expect(row.stockOnHand).toBe(12); // 5 + 3 + 4
  });

  it("resolves the parent category's name", async () => {
    const parent = await prisma.category.create({ data: { name: "Vêtements", slug: "vetements" } });
    await prisma.category.create({ data: { name: "Robes", slug: "robes", parentId: parent.id } });

    const rows = await listCategoriesWithStats();
    const child = rows.find((r) => r.slug === "robes")!;
    expect(child.parentName).toBe("Vêtements");
  });
});

/**
 * « Afficher 10 | 50 | 100 par page » — the list honours an explicit
 * `pageSize`, keeps the 20 default for other callers, and pages are disjoint
 * even when the business sort ties (the `id` tie-break).
 */
describe("listProducts — pageSize and stable pages", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("uses the given page size, defaults to 20, and never repeats a row across pages", async () => {
    for (let i = 0; i < 25; i++) {
      // Same name and price: only the id tie-break orders them.
      await prisma.product.create({ data: { name: "Même nom", sku: `P-${i}-${Math.random()}`, price: 10, status: "ACTIF" } });
    }
    const def = await listProducts({});
    expect(def.pageSize).toBe(20);
    expect(def.products).toHaveLength(20);

    const p1 = await listProducts({ sort: "name", page: 1, pageSize: 10 });
    const p2 = await listProducts({ sort: "name", page: 2, pageSize: 10 });
    const p3 = await listProducts({ sort: "name", page: 3, pageSize: 10 });
    expect(p1.pageSize).toBe(10);
    expect(p1.total).toBe(25);
    expect(p3.products).toHaveLength(5);
    const ids = [...p1.products, ...p2.products, ...p3.products].map((p) => p.id);
    expect(new Set(ids).size).toBe(25);

    const big = await listProducts({ page: 1, pageSize: 50 });
    expect(big.products).toHaveLength(25);
  });
});
