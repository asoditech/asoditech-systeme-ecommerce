import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { ensureProductQrToken, ensureVariationQrToken, resolveScanToken, scanUrl } from "@/lib/catalog/labels";
import { generateRawToken } from "@/lib/auth/tokens";
import { resetDb } from "../helpers/db";

/**
 * QR-label identity — docs/adr/0042. `ensure*QrToken` is the lazy
 * generate-once step; `resolveScanToken` is what the PUBLIC, unauthenticated
 * `/scan/[token]` route calls, so its output is the entire public surface
 * area and must never carry cost/price/supplier/internal fields.
 */

beforeEach(async () => await resetDb());
afterEach(async () => await resetDb());

describe("ensureProductQrToken / ensureVariationQrToken", () => {
  it("generates a token for a product that has none, and is idempotent", async () => {
    const product = await prisma.product.create({ data: { name: "Coffret", sku: `P-${Math.random()}`, price: 100, status: "ACTIF" } });
    expect(product.qrToken).toBeNull();

    const token1 = await ensureProductQrToken(product.id);
    expect(token1.length).toBeGreaterThan(16);
    const token2 = await ensureProductQrToken(product.id);
    expect(token2).toBe(token1); // second call reuses the existing token, never regenerates

    const stored = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(stored.qrToken).toBe(token1);
  });

  it("generates a SEPARATE token per variation, never one shared across a product's variations", async () => {
    const product = await prisma.product.create({ data: { name: "T-Shirt", sku: `P-${Math.random()}`, price: 100, status: "ACTIF" } });
    const v1 = await prisma.productVariation.create({ data: { productId: product.id, sku: `V1-${Math.random()}`, attributes: { Taille: "S" } } });
    const v2 = await prisma.productVariation.create({ data: { productId: product.id, sku: `V2-${Math.random()}`, attributes: { Taille: "M" } } });

    const t1 = await ensureVariationQrToken(v1.id);
    const t2 = await ensureVariationQrToken(v2.id);
    expect(t1).not.toBe(t2);
  });

  it("does not generate a token for every variation just because one was requested (lazy — only the requested unit gets one)", async () => {
    const product = await prisma.product.create({ data: { name: "T-Shirt", sku: `P-${Math.random()}`, price: 100, status: "ACTIF" } });
    const v1 = await prisma.productVariation.create({ data: { productId: product.id, sku: `V1-${Math.random()}`, attributes: { Taille: "S" } } });
    const v2 = await prisma.productVariation.create({ data: { productId: product.id, sku: `V2-${Math.random()}`, attributes: { Taille: "M" } } });

    await ensureVariationQrToken(v1.id);
    expect((await prisma.productVariation.findUniqueOrThrow({ where: { id: v2.id } })).qrToken).toBeNull();
  });

  it("throws for an unknown product/variation id rather than silently creating a token for nothing", async () => {
    await expect(ensureProductQrToken("does-not-exist")).rejects.toThrow(/introuvable/i);
    await expect(ensureVariationQrToken("does-not-exist")).rejects.toThrow(/introuvable/i);
  });
});

describe("scanUrl", () => {
  it("builds an absolute /scan/<token> URL", () => {
    const url = scanUrl("abc123");
    expect(url).toMatch(/\/scan\/abc123$/);
    expect(url.startsWith("http")).toBe(true);
  });
});

describe("resolveScanToken — the entire public surface of the QR scan page", () => {
  it("resolves a simple product's safe fields, and ONLY those fields", async () => {
    const category = await prisma.category.create({ data: { name: "Chaussures", slug: `chaussures-${Math.random()}` } });
    const product = await prisma.product.create({
      data: { name: "Basket Air", sku: `P-${Math.random()}`, price: 500, cost: 300, categoryId: category.id, status: "ACTIF" },
    });
    await prisma.barcode.create({ data: { productId: product.id, code: "1234567890123", isPrimary: true } });
    const token = await ensureProductQrToken(product.id);

    const result = await resolveScanToken(token);
    expect(result).toEqual({
      kind: "product",
      productName: "Basket Air",
      variantAttributes: null,
      variantLabel: null,
      sku: product.sku,
      primaryBarcode: "1234567890123",
      categoryName: "Chaussures",
      imageUrl: null,
      companyName: null, // no BusinessSettings row seeded in this test
    });
    // Explicit negative check — the very information the spec forbids exposing.
    expect(result).not.toHaveProperty("cost");
    expect(result).not.toHaveProperty("price");
    expect(result).not.toHaveProperty("supplier");
  });

  it("resolves a VARIATION's own token to the variation's identity, distinct from its product's", async () => {
    const product = await prisma.product.create({ data: { name: "T-Shirt", sku: `P-${Math.random()}`, price: 150, status: "ACTIF" } });
    const variation = await prisma.productVariation.create({
      data: { productId: product.id, sku: `V-${Math.random()}`, attributes: { Couleur: "Rouge", Taille: "M" }, cost: 60 },
    });
    await prisma.barcode.create({ data: { variationId: variation.id, code: "9998887776665", isPrimary: true } });
    const token = await ensureVariationQrToken(variation.id);

    const result = await resolveScanToken(token);
    expect(result?.kind).toBe("variation");
    expect(result?.productName).toBe("T-Shirt");
    expect(result?.variantAttributes).toEqual({ Couleur: "Rouge", Taille: "M" });
    expect(result?.sku).toBe(variation.sku); // the VARIATION's sku, not the product's
    expect(result?.primaryBarcode).toBe("9998887776665");
    expect(result).not.toHaveProperty("cost");
  });

  it("returns null for an unknown or garbage token — never throws", async () => {
    expect(await resolveScanToken("this-token-does-not-exist-anywhere")).toBeNull();
    expect(await resolveScanToken("")).toBeNull();
  });

  it("a token from one tenant never resolves another tenant's product, and shows that tenant's OWN company name", async () => {
    const productA = await prisma.product.create({ data: { name: "Produit A", sku: `A-${Math.random()}`, price: 100, status: "ACTIF" } });
    await prisma.businessSettings.create({ data: { tenantId: "default", companyName: "ASODITECH Casa" } });
    const tokenA = await ensureProductQrToken(productA.id);

    await prismaBase.tenant.create({ data: { id: "tenant-b-scan", name: "B", slug: "tenant-b-scan" } });
    const tokenB = generateRawToken();
    const productB = await prismaBase.product.create({
      data: { name: "Produit B", sku: `B-${Math.random()}`, price: 200, tenantId: "tenant-b-scan", status: "ACTIF", qrToken: tokenB },
    });
    await prismaBase.businessSettings.create({ data: { tenantId: "tenant-b-scan", companyName: "Boutique B" } });
    void productB; // token set directly — `ensureProductQrToken` deliberately can't reach across tenants (session-scoped `prisma`)

    const resultA = await resolveScanToken(tokenA);
    expect(resultA?.productName).toBe("Produit A");
    expect(resultA?.companyName).toBe("ASODITECH Casa");

    const resultB = await resolveScanToken(tokenB);
    expect(resultB?.productName).toBe("Produit B");
    expect(resultB?.companyName).toBe("Boutique B"); // tenant B's own name, never tenant A's
  });
});
