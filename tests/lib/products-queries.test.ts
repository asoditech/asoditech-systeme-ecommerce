import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { listProducts } from "@/lib/queries/products";
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
