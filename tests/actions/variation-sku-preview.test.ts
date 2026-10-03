import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { generateProductVariationsAction, previewProductVariationsAction } from "@/actions/products";
import { addBarcodeAction } from "@/actions/catalog";
import { suggestVariationSku } from "@/lib/catalog/variations";
import { findTraceUnits } from "@/lib/queries/traceability";
import { loadExportProducts } from "@/lib/catalog/export/load";
import { buildWooCommerceCsv } from "@/lib/catalog/export/woocommerce";
import { labelBarcode } from "@/lib/catalog/label-barcode";
import { gs1CheckDigitWarning } from "@/lib/catalog/gs1";
import ProductLabelPage from "@/app/(protected)/produits/[id]/etiquette/page";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * SKU preview for the combination generator (previewProductVariationsAction
 * runs the creation's own planner, read-only) and the internal-code label
 * (no Barcode row is ever written; nothing reaches the GTIN export column;
 * the existing exact-SKU lookup finds the item).
 */

beforeEach(async () => {
  await resetDb();
  await setTestBusinessMode("ONLINE_AND_OFFLINE");
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

const OPTIONS = [
  { name: "Couleur", values: ["Noir", "Blanc"] },
  { name: "Taille", values: ["S", "M"] },
];

async function tsb() {
  return prisma.product.create({ data: { name: "T-shirt Basic", sku: "TSB", reference: "TSB", price: 99, status: "ACTIF" } });
}

const writes = async () =>
  Promise.all([prismaBase.productVariation.count(), prismaBase.barcode.count(), prismaBase.inventoryItem.count(), prismaBase.auditEvent.count()]);

describe("previewProductVariationsAction — SKUs shown before creation", () => {
  it("shows, per new combination, the SKU from the existing algorithm (Reference + values) — and writes nothing", async () => {
    const product = await tsb();
    await loginAsTestUser({ role: "ADMIN" });
    const before = await writes();

    const r = await previewProductVariationsAction({ productId: product.id, options: OPTIONS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.rows.map((x) => x.sku)).toEqual(["TSB-NOIR-S", "TSB-NOIR-M", "TSB-BLANC-S", "TSB-BLANC-M"]);
    for (const row of r.data.rows) expect(row.sku).toBe(suggestVariationSku("TSB", row.attributes));
    expect(await writes()).toEqual(before);
  });

  it("the preview is exactly what creation then assigns", async () => {
    const product = await tsb();
    await loginAsTestUser({ role: "ADMIN" });
    const preview = await previewProductVariationsAction({ productId: product.id, options: OPTIONS });
    const created = await generateProductVariationsAction({ productId: product.id, options: OPTIONS });
    expect(created.ok).toBe(true);
    const skus = (await prisma.productVariation.findMany({ where: { productId: product.id }, select: { sku: true } })).map((v) => v.sku).sort();
    expect(preview.ok && preview.data.rows.map((x) => x.sku).sort()).toEqual(skus);
  });

  it("duplicate handling: a SKU already used by another product or by a barcode is shown adjusted (-2), as creation does", async () => {
    const product = await tsb();
    await prisma.product.create({ data: { name: "Autre", sku: "TSB-NOIR-S", price: 1 } });
    const other = await prisma.product.create({ data: { name: "Autre 2", sku: "OTHER-2", price: 1 } });
    await prisma.barcode.create({ data: { code: "TSB-BLANC-M", productId: other.id, isPrimary: true } });
    await loginAsTestUser({ role: "ADMIN" });

    const r = await previewProductVariationsAction({ productId: product.id, options: OPTIONS });
    if (!r.ok) throw new Error(r.error);
    const bySuggested = Object.fromEntries(r.data.rows.map((x) => [x.suggestedSku, x.sku]));
    expect(bySuggested["TSB-NOIR-S"]).toBe("TSB-NOIR-S-2");
    expect(bySuggested["TSB-BLANC-M"]).toBe("TSB-BLANC-M-2");
    expect(bySuggested["TSB-NOIR-M"]).toBe("TSB-NOIR-M");

    await generateProductVariationsAction({ productId: product.id, options: OPTIONS });
    const created = (await prisma.productVariation.findMany({ where: { productId: product.id }, select: { sku: true } })).map((v) => v.sku);
    expect(created).toEqual(expect.arrayContaining(["TSB-NOIR-S-2", "TSB-BLANC-M-2"]));
  });

  it("existing variations keep their (edited) SKU: excluded from the preview and untouched by regeneration", async () => {
    const product = await tsb();
    await prisma.productVariation.create({ data: { productId: product.id, sku: "MON-SKU-PERSO", attributes: { Couleur: "Noir", Taille: "S" } } });
    await loginAsTestUser({ role: "ADMIN" });

    const r = await previewProductVariationsAction({ productId: product.id, options: OPTIONS });
    if (!r.ok) throw new Error(r.error);
    expect(r.data.existingCount).toBe(1);
    expect(r.data.rows.map((x) => x.attributes)).not.toContainEqual({ Couleur: "Noir", Taille: "S" });

    await generateProductVariationsAction({ productId: product.id, options: OPTIONS });
    const kept = await prisma.productVariation.findFirstOrThrow({ where: { productId: product.id, sku: "MON-SKU-PERSO" } });
    expect(kept.attributes).toEqual({ Couleur: "Noir", Taille: "S" });
    expect(await prisma.productVariation.count({ where: { productId: product.id } })).toBe(4);
  });

  it("is refused without products.edit, and for a store-synced product", async () => {
    const product = await tsb();
    await loginAsTestUser({ role: "CONFIRMATION" });
    await expect(previewProductVariationsAction({ productId: product.id, options: OPTIONS })).rejects.toThrow(/non autorisé/i);

    mockCookieStore.clear();
    await loginAsTestUser({ role: "ADMIN" });
    const synced = await prisma.product.create({ data: { name: "Woo", sku: "WOO-1", price: 1, source: "WOOCOMMERCE", externalId: "77" } });
    expect((await previewProductVariationsAction({ productId: synced.id, options: OPTIONS })).ok).toBe(false);
  });
});

describe("internal-code label", () => {
  it("rendering the label of a unit without barcode stores NO Barcode row and encodes its SKU", async () => {
    const product = await tsb();
    const variation = await prisma.productVariation.create({ data: { productId: product.id, sku: "TSB-NOIR-M", attributes: { Couleur: "Noir", Taille: "M" } } });
    await loginAsTestUser({ role: "ADMIN" });

    await ProductLabelPage({ params: Promise.resolve({ id: product.id }), searchParams: Promise.resolve({ variation: variation.id }) });
    expect(await prisma.barcode.count()).toBe(0); // official Barcode field untouched
    expect(labelBarcode({ barcode: null, sku: variation.sku })).toEqual({ kind: "internal", value: "TSB-NOIR-M" });
  });

  it("the internal code never reaches the e-commerce GTIN export column", async () => {
    const product = await prisma.product.create({ data: { name: "Casquette", sku: "CAP-1", price: 50, status: "ACTIF" } });
    await loginAsTestUser({ role: "ADMIN" });
    const { headers, rows } = buildWooCommerceCsv(await loadExportProducts([product.id]));
    const gtin = headers.indexOf("GTIN, UPC, EAN, or ISBN");
    expect(gtin).toBeGreaterThanOrEqual(0);
    expect(rows[0][gtin]).toBe("");
  });

  it("scanning the internal code finds the unit through the existing exact-SKU lookup", async () => {
    const product = await tsb();
    const variation = await prisma.productVariation.create({ data: { productId: product.id, sku: "TSB-NOIR-M", attributes: { Couleur: "Noir", Taille: "M" } } });
    await loginAsTestUser({ role: "ADMIN" });
    const units = await findTraceUnits("TSB-NOIR-M");
    expect(units.map((u) => [u.variationId, u.matchedBy])).toEqual([[variation.id, "sku"]]);
  });
});

describe("GS1 warning is never blocking", () => {
  it("a numeric code with a wrong GS1 check digit is still saved, unchanged", async () => {
    const product = await prisma.product.create({ data: { name: "Robe", sku: "ROBE-1", price: 200 } });
    await loginAsTestUser({ role: "ADMIN" });
    const code = "4006381333932"; // check digit should be 1
    expect(gs1CheckDigitWarning(code)).not.toBeNull();
    const r = await addBarcodeAction({ productId: product.id, code, makePrimary: true });
    expect(r.ok).toBe(true);
    expect((await prisma.barcode.findFirstOrThrow({ where: { productId: product.id } })).code).toBe(code);
  });
});
