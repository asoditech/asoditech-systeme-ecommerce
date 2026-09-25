import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { lookupSellableUnits } from "@/lib/catalog/lookup";
import { resetDb } from "../helpers/db";

/**
 * Batch 4 (Variant System Rebuild) — the shared sellable-unit search
 * (reception/Sale-POS/traceability), extended for: variation.salePrice
 * price precedence, and `onlyActive` now also excluding an inactive
 * variation (Task 11), never just the product's own status.
 */
describe("lookupSellableUnits — variation salePrice & isActive (Batch 4)", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  async function seedVariantProduct(overrides: {
    variationPrice?: number | null;
    variationSalePrice?: number | null;
    productSalePrice?: number | null;
    isActive?: boolean;
  } = {}) {
    const product = await prisma.product.create({
      data: {
        name: "T-Shirt Badyss Classic",
        sku: `TSH-${Math.random()}`,
        reference: "TSH-BADYSS",
        price: 200,
        salePrice: overrides.productSalePrice,
        status: "ACTIF",
      },
    });
    const variation = await prisma.productVariation.create({
      data: {
        productId: product.id,
        sku: `TSH-BADYSS-NOIR-M-${Math.random()}`,
        attributes: { Couleur: "Noir", Taille: "M" },
        price: overrides.variationPrice,
        salePrice: overrides.variationSalePrice,
        isActive: overrides.isActive ?? true,
      },
    });
    return { product, variation };
  }

  it("finds a variation by its parent product's NAME", async () => {
    const { variation } = await seedVariantProduct();
    const hits = await lookupSellableUnits(prisma, "T-Shirt Badyss");
    expect(hits.some((h) => h.variationId === variation.id)).toBe(true);
  });

  it("finds a variation by its parent product's REFERENCE", async () => {
    const { variation } = await seedVariantProduct();
    const hits = await lookupSellableUnits(prisma, "TSH-BADYSS");
    expect(hits.some((h) => h.variationId === variation.id)).toBe(true);
  });

  it("finds a variation by its OWN sku (exact)", async () => {
    const { variation } = await seedVariantProduct();
    const hits = await lookupSellableUnits(prisma, variation.sku);
    expect(hits).toHaveLength(1);
    expect(hits[0].variationId).toBe(variation.id);
    expect(hits[0].matchedBy).toBe("sku");
  });

  it("finds a variation by its barcode (exact)", async () => {
    const { variation } = await seedVariantProduct();
    await prisma.barcode.create({ data: { code: "6119990000011", variationId: variation.id, isPrimary: true } });
    const hits = await lookupSellableUnits(prisma, "6119990000011");
    expect(hits).toHaveLength(1);
    expect(hits[0].variationId).toBe(variation.id);
    expect(hits[0].matchedBy).toBe("barcode");
  });

  it("finds a variation by its option combination (attribute VALUE is not itself indexed, but the product name/ref search still surfaces it)", async () => {
    // The lookup predicate doesn't index JSON attributes directly — a
    // combination is found via its SKU (which the suggestion embeds the
    // values into) or the parent product, not a raw attribute-value search.
    const { variation } = await seedVariantProduct();
    const hits = await lookupSellableUnits(prisma, "NOIR-M");
    expect(hits.some((h) => h.variationId === variation.id)).toBe(true);
  });

  it("price precedence: variation.salePrice wins over everything else", async () => {
    const { variation } = await seedVariantProduct({ variationPrice: 180, variationSalePrice: 150, productSalePrice: 190 });
    const hits = await lookupSellableUnits(prisma, variation.sku);
    expect(hits[0].price).toBe(150);
  });

  it("price precedence falls back through variation.price -> product.salePrice -> product.price", async () => {
    const noOverride = await seedVariantProduct();
    const withVariationPrice = await seedVariantProduct({ variationPrice: 175 });
    const withProductSalePrice = await seedVariantProduct({ productSalePrice: 160 });

    expect((await lookupSellableUnits(prisma, noOverride.variation.sku))[0].price).toBe(200); // product.price
    expect((await lookupSellableUnits(prisma, withVariationPrice.variation.sku))[0].price).toBe(175);
    expect((await lookupSellableUnits(prisma, withProductSalePrice.variation.sku))[0].price).toBe(160);
  });

  it("onlyActive (default) excludes an inactive variation from a partial/name search", async () => {
    const { product } = await seedVariantProduct({ isActive: false });
    const hits = await lookupSellableUnits(prisma, product.name);
    expect(hits).toHaveLength(0);
  });

  it("onlyActive: false still returns an inactive variation (management/history contexts)", async () => {
    const { product, variation } = await seedVariantProduct({ isActive: false });
    const hits = await lookupSellableUnits(prisma, product.name, { onlyActive: false });
    expect(hits.some((h) => h.variationId === variation.id)).toBe(true);
  });

  it("a barcode scan of an inactive variation returns nothing — never falls through to a fuzzy match", async () => {
    const { variation } = await seedVariantProduct({ isActive: false });
    await prisma.barcode.create({ data: { code: "6119990000099", variationId: variation.id, isPrimary: true } });
    const hits = await lookupSellableUnits(prisma, "6119990000099");
    expect(hits).toHaveLength(0);
  });

  it("an exact SKU match on an inactive variation returns nothing", async () => {
    const { variation } = await seedVariantProduct({ isActive: false });
    const hits = await lookupSellableUnits(prisma, variation.sku);
    expect(hits).toHaveLength(0);
  });

  it("a product with one active and one inactive variation still returns the active one", async () => {
    const product = await prisma.product.create({
      data: { name: "Multi", sku: `MULTI-${Math.random()}`, price: 100, status: "ACTIF" },
    });
    const active = await prisma.productVariation.create({
      data: { productId: product.id, sku: `MULTI-A-${Math.random()}`, attributes: { Taille: "S" }, isActive: true },
    });
    const inactive = await prisma.productVariation.create({
      data: { productId: product.id, sku: `MULTI-B-${Math.random()}`, attributes: { Taille: "M" }, isActive: false },
    });
    const hits = await lookupSellableUnits(prisma, product.name);
    const ids = hits.map((h) => h.variationId);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(inactive.id);
  });
});
