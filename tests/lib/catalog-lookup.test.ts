import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { explainExactMiss, lookupSellableUnits } from "@/lib/catalog/lookup";
import { runWithTenant } from "@/lib/tenant/context";
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

  it("a scanner's other spelling of the same code still matches: letter case, UPC-A vs EAN-13", async () => {
    const { variation } = await seedVariantProduct();
    await prisma.barcode.create({ data: { code: "AbC-778", variationId: variation.id, isPrimary: true } });
    await prisma.barcode.create({ data: { code: "0012345678905", variationId: variation.id } });
    for (const scanned of ["ABC-778", "abc-778", "012345678905", "00012345678905"]) {
      const hits = await lookupSellableUnits(prisma, scanned);
      expect(hits.map((h) => [h.variationId, h.matchedBy])).toEqual([[variation.id, "barcode"]]);
    }
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

/**
 * The ASODITECH label's QR (`https://…/scan/<token>`) read by a 2D scanner
 * or the lookup screens' camera resolves to its article — inside the
 * caller's tenant only — and a miss on a filtered search says why.
 */
describe("lookupSellableUnits — label QR, tenant isolation; explainExactMiss", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  const TOKEN_V = "VmFyaWF0aW9uLWxhYmVsLXRva2VuLTAwMDAwMDAwMDAx";
  const TOKEN_P = "UHJvZHVjdC1sYWJlbC10b2tlbi0wMDAwMDAwMDAwMDAx";
  const url = (t: string) => `https://www.asoditech.com/scan/${t}`;

  async function seed() {
    const simple = await prisma.product.create({ data: { name: "Casquette", sku: "CAP-1", price: 50, status: "ACTIF", qrToken: TOKEN_P } });
    const parent = await prisma.product.create({ data: { name: "T-shirt", sku: "TS-PARENT", price: 100, status: "ACTIF" } });
    const noir = await prisma.productVariation.create({
      data: { productId: parent.id, sku: "TS-NOIR", attributes: { Couleur: "Noir" }, isActive: true, qrToken: TOKEN_V },
    });
    await prisma.productVariation.create({ data: { productId: parent.id, sku: "TS-BLANC", attributes: { Couleur: "Blanc" }, isActive: true } });
    return { simple, parent, noir };
  }

  it("a variation label QR → exactly that variation; a simple product's → that product", async () => {
    const { simple, noir } = await seed();
    expect(await lookupSellableUnits(prisma, url(TOKEN_V))).toEqual([expect.objectContaining({ variationId: noir.id, matchedBy: "barcode" })]);
    expect(await lookupSellableUnits(prisma, `  ${url(TOKEN_P)}/  `)).toEqual([expect.objectContaining({ productId: simple.id, variationId: null })]);
  });

  it("an unknown label token finds nothing — never a partial match on the URL text", async () => {
    await seed();
    expect(await lookupSellableUnits(prisma, url("Tm90LWEtcmVhbC10b2tlbi0wMDAwMDAwMDAwMDAwMDAw"))).toEqual([]);
  });

  it("another tenant's label QR resolves to nothing (and to its own article in that tenant)", async () => {
    await prismaBase.tenant.create({ data: { id: "tenant-b", name: "B", slug: "tenant-b" } });
    const other = await prismaBase.product.create({
      data: { tenantId: "tenant-b", name: "Article B", sku: "B-1", price: 10, status: "ACTIF", qrToken: TOKEN_P },
    });
    expect(await runWithTenant("default", "test:label-qr", () => lookupSellableUnits(prisma, url(TOKEN_P)))).toEqual([]);
    expect(await runWithTenant("default", "test:label-qr", () => explainExactMiss(prisma, url(TOKEN_P)))).toEqual({ reason: "unknown" });
    const own = await runWithTenant("tenant-b", "test:label-qr", () => lookupSellableUnits(prisma, url(TOKEN_P)));
    expect(own.map((u) => u.productId)).toEqual([other.id]);
  });

  it("an archived article's label QR / barcode: nothing on an active-only search, and the miss says « inactive »", async () => {
    const { simple } = await seed();
    await prisma.product.update({ where: { id: simple.id }, data: { status: "ARCHIVE" } });
    await prisma.barcode.create({ data: { code: "6111234567895", productId: simple.id, isPrimary: true } });
    expect(await lookupSellableUnits(prisma, url(TOKEN_P))).toEqual([]);
    expect(await lookupSellableUnits(prisma, "6111234567895")).toEqual([]);
    expect(await explainExactMiss(prisma, url(TOKEN_P))).toEqual({ reason: "inactive", label: "Casquette" });
    expect(await explainExactMiss(prisma, "6111234567895")).toEqual({ reason: "inactive", label: "Casquette" });
  });

  it("a disabled variation → « inactive »; an article not on the channel → « not_on_channel »; unknown → « unknown »", async () => {
    const { simple, noir } = await seed();
    await prisma.productVariation.update({ where: { id: noir.id }, data: { isActive: false } });
    expect(await explainExactMiss(prisma, "TS-NOIR")).toEqual({ reason: "inactive", label: "T-shirt — Noir" });
    const shop = await prisma.salesChannel.create({ data: { name: "Boutique", kind: "OFFLINE" } });
    expect(await lookupSellableUnits(prisma, "CAP-1", { channelId: shop.id })).toEqual([]);
    expect(await explainExactMiss(prisma, "CAP-1", { channelId: shop.id })).toEqual({ reason: "not_on_channel", label: "Casquette" });
    await prisma.productSalesChannel.create({ data: { productId: simple.id, salesChannelId: shop.id } });
    expect(await lookupSellableUnits(prisma, "CAP-1", { channelId: shop.id })).toHaveLength(1);
    expect(await explainExactMiss(prisma, "NOPE-404", { channelId: shop.id })).toEqual({ reason: "unknown" });
    expect(await explainExactMiss(prisma, "Casq", { channelId: shop.id })).toEqual({ reason: "unknown" }); // never partial
  });
});
