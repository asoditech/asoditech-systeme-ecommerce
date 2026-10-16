import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { getMissingCostSummary } from "@/lib/queries/missing-cost";
import { listProducts } from "@/lib/queries/products";
import { missingCostMessage } from "@/lib/catalog/missing-cost";
import { resetDb } from "../helpers/db";

/**
 * B3 — « coût d'achat manquant »: which sellable units have no purchase cost
 * (variation cost, else product cost — the fallback order lines freeze), for
 * ACTIF products only, in the current tenant only. DB-backed.
 */

const TENANT_B = "tenant-b-costs";

beforeEach(async () => await resetDb());
afterEach(async () => await resetDb());

async function seed() {
  const simpleMissing = await prisma.product.create({ data: { name: "Simple sans coût", sku: "S-1", price: 10, status: "ACTIF" } });
  await prisma.product.create({ data: { name: "Simple avec coût", sku: "S-2", price: 10, cost: 4, status: "ACTIF" } });
  await prisma.product.create({ data: { name: "Archivé sans coût", sku: "S-3", price: 10, status: "ARCHIVE" } });
  await prisma.product.create({ data: { name: "Brouillon sans coût", sku: "S-4", price: 10, status: "BROUILLON" } });

  // Imported variable product: one active variation without cost, one with,
  // one INACTIVE without (not sellable → not counted).
  const wooVariable = await prisma.product.create({
    data: {
      name: "T-shirt Woo", sku: "WOO-1", price: 10, status: "ACTIF", source: "WOOCOMMERCE", externalId: "77",
      variations: {
        create: [
          { sku: "WOO-1-S", attributes: {}, price: 10 },
          { sku: "WOO-1-M", attributes: {}, price: 10, cost: 3 },
          { sku: "WOO-1-L", attributes: {}, price: 10, isActive: false },
        ],
      },
    },
  });
  // Variation without its own cost but the product has one → covered by the fallback.
  await prisma.product.create({
    data: { name: "Pull", sku: "P-1", price: 10, cost: 5, status: "ACTIF", variations: { create: [{ sku: "P-1-S", attributes: {}, price: 10 }] } },
  });
  // All variations costed → not missing even though the parent has no cost.
  await prisma.product.create({
    data: { name: "Short", sku: "SH-1", price: 10, status: "ACTIF", source: "SHOPIFY", variations: { create: [{ sku: "SH-1-S", attributes: {}, price: 10, cost: 2 }] } },
  });
  return { simpleMissing, wooVariable };
}

describe("missing purchase cost", () => {
  it("counts simple products and active variations without an effective cost, ACTIF only, by source", async () => {
    await seed();
    const s = await getMissingCostSummary();
    expect(s.bySource).toEqual({ INTERNE: 1, WOOCOMMERCE: 1, SHOPIFY: 0 });
    expect(s.units).toBe(2);
    expect(s.products).toBe(2);
    expect(missingCostMessage(s)).toBe("2 produit(s)/variante(s) sans coût d'achat : les marges et rapports financiers sont incomplets.");
    expect(s.withLocationCost).toBe(0);
  });

  it("a unit costed only at one location stays missing (imported orders use the global cost) and is reported as such", async () => {
    const { simpleMissing } = await seed();
    const warehouse = await prisma.warehouse.create({ data: { name: "Rabat", isDefault: true } });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: simpleMissing.id, quantityOnHand: 1, currentUnitCost: 7 } });
    const s = await getMissingCostSummary();
    expect(s.units).toBe(2);
    expect(s.withLocationCost).toBe(1);
  });

  it("the « Coût d'achat manquant » list filter returns exactly the concerned products, and combines with search", async () => {
    const { simpleMissing, wooVariable } = await seed();
    const { products, total } = await listProducts({ missingCost: true, pageSize: 50 });
    expect(total).toBe(2);
    expect(products.map((p) => p.id).sort()).toEqual([simpleMissing.id, wooVariable.id].sort());
    const searched = await listProducts({ missingCost: true, q: "T-shirt", pageSize: 50 });
    expect(searched.products.map((p) => p.id)).toEqual([wooVariable.id]);
  });

  it("disappears once the costs are entered (nothing to dismiss)", async () => {
    const { simpleMissing, wooVariable } = await seed();
    await prisma.product.update({ where: { id: simpleMissing.id }, data: { cost: 6 } });
    await prisma.productVariation.updateMany({ where: { productId: wooVariable.id, sku: "WOO-1-S" }, data: { cost: 3 } });
    const s = await getMissingCostSummary();
    expect(s.units).toBe(0);
    expect(missingCostMessage(s)).toBeNull();
    expect((await listProducts({ missingCost: true })).total).toBe(0);
  });

  it("another tenant's products are never counted", async () => {
    await seed();
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    await prismaBase.product.create({ data: { tenantId: TENANT_B, name: "B sans coût", sku: "B-1", price: 1, status: "ACTIF" } });
    expect((await getMissingCostSummary()).units).toBe(2);
    const asB = await runWithTenant(TENANT_B, "test", () => getMissingCostSummary());
    expect(asB).toMatchObject({ units: 1, products: 1, bySource: { INTERNE: 1, WOOCOMMERCE: 0, SHOPIFY: 0 } });
  });
});
