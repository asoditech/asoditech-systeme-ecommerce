import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { generateProductBarcodeAction, addBarcodeAction } from "@/actions/catalog";
import { createProductAction, generateProductVariationsAction } from "@/actions/products";
import { updateProductBarcodeAutoAction } from "@/actions/settings";
import { lookupSellableUnits } from "@/lib/catalog/lookup";
import { exportableBarcode } from "@/lib/catalog/export/load";
import { isGeneratedProductBarcode } from "@/lib/catalog/generated-barcode";
import { buildTenantBackup } from "@/lib/backup/export";
import { inspectBackup, restoreTenantBackup } from "@/lib/backup/import";
import { DEFAULT_TENANT_ID, resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Automatic PRODUCT / VARIATION barcode generation (docs/adr/0061):
 * tenant switch, « Générer », one code per variation, uniqueness (existing
 * index + allocation skips), concurrency, scanning, export, backup.
 */

const TENANT_B = "tenant-b-product-codes";

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function setSwitch(enabled: boolean, tenantId = DEFAULT_TENANT_ID) {
  await runWithTenant(tenantId, "test", () =>
    prisma.businessSettings.upsert({ where: { tenantId }, update: { productBarcodeAutoEnabled: enabled }, create: { productBarcodeAutoEnabled: enabled } })
  );
}

async function generate(): Promise<string> {
  const r = await generateProductBarcodeAction();
  if (!r.ok) throw new Error(r.error);
  return r.data.code;
}

async function variableProduct(sku = "TSHIRT") {
  // Distinct names: variation SKUs are derived from the product name.
  return prisma.product.create({ data: { name: `T-shirt ${sku}`, sku, price: 100, status: "ACTIF" } });
}

const SIZES = [{ name: "Taille", values: ["S", "M", "L"] }];

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

describe("setting off (default): manual entry unchanged, no generation", () => {
  it("off by default; « Générer » is refused; manual barcodes still save on create and in Identité", async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    await loginAsTestUser({ role: "OWNER" });
    const refused = await generateProductBarcodeAction();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/désactivée/);

    const created = await createProductAction(fd({ name: "Manuel", sku: "MAN-1", price: "10", barcode: "6111000000014" }));
    expect(created.ok).toBe(true);
    const p = await prisma.product.create({ data: { name: "P2", sku: "MAN-2", price: 1, status: "ACTIF" } });
    expect((await addBarcodeAction({ productId: p.id, code: "00012345" })).ok).toBe(true);
    expect((await prisma.barcode.findFirstOrThrow({ where: { code: "00012345" } })).code).toBe("00012345"); // leading zeros kept
    expect(await prismaBase.tenant.findUniqueOrThrow({ where: { id: DEFAULT_TENANT_ID } }).then((t) => t.nextProductBarcodeNumber)).toBe(BigInt(1));
  });

  it("the variation generator still works without codes, and refuses generateBarcodes while off", async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    await loginAsTestUser({ role: "OWNER" });
    const product = await variableProduct();
    const refused = await generateProductVariationsAction({ productId: product.id, options: SIZES, generateBarcodes: true });
    expect(refused.ok).toBe(false);
    expect(await prisma.productVariation.count()).toBe(0);
    const plain = await generateProductVariationsAction({ productId: product.id, options: SIZES });
    expect(plain.ok && plain.data).toEqual({ created: 3, skippedExisting: 0, barcodesGenerated: 0 });
    expect(await prisma.barcode.count()).toBe(0);
  });
});

describe("settings", () => {
  it("settings.manage + catalogIdentity can turn it on (audited); off is always allowed", async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    await loginAsTestUser({ role: "OWNER" });
    expect((await updateProductBarcodeAutoAction(fd({ productBarcodeAutoEnabled: "on" }))).ok).toBe(true);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "settings.updated" }, orderBy: { createdAt: "desc" } });
    expect(audit.newValue).toEqual({ productBarcodeAutoEnabled: true });
    expect((await updateProductBarcodeAutoAction(fd({ productBarcodeAutoEnabled: "false" }))).ok).toBe(true);
  });

  it("needs settings.manage", async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    await loginAsTestUser({ role: "MANAGER" });
    await expect(updateProductBarcodeAutoAction(fd({ productBarcodeAutoEnabled: "on" }))).rejects.toThrow(/non autorisé/i);
  });

  it("an ONLINE_ONLY tenant (no barcodes at all) cannot turn it on", async () => {
    await loginAsTestUser({ role: "OWNER" });
    await expect(updateProductBarcodeAutoAction(fd({ productBarcodeAutoEnabled: "on" }))).rejects.toThrow();
  });
});

describe("generation (setting on)", () => {
  beforeEach(async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    await setSwitch(true);
  });

  it("simple product: « Générer » hands out 2000000000015, then 2000000000022; the create form saves it", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const code = await generate();
    expect(code).toBe("2000000000015");
    const created = await createProductAction(fd({ name: "Généré", sku: "GEN-1", price: "10", barcode: code }));
    expect(created.ok).toBe(true);
    const saved = await prisma.barcode.findFirstOrThrow({ where: { code } });
    expect(saved.isPrimary).toBe(true);
    expect(await generate()).toBe("2000000000022");
  });

  it("variations: the generator gives EACH new variation its own distinct primary code; the parent gets none", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const product = await variableProduct();
    const r = await generateProductVariationsAction({ productId: product.id, options: SIZES, generateBarcodes: true });
    expect(r.ok && r.data).toEqual({ created: 3, skippedExisting: 0, barcodesGenerated: 3 });
    const variations = await prisma.productVariation.findMany({ include: { barcodes: true } });
    const codes = variations.map((v) => v.barcodes.map((b) => b.code));
    expect(codes.every((c) => c.length === 1)).toBe(true);
    expect(new Set(codes.flat()).size).toBe(3);
    expect(codes.flat().every(isGeneratedProductBarcode)).toBe(true);
    expect(variations.every((v) => v.barcodes[0].isPrimary)).toBe(true);
    expect(await prisma.barcode.count({ where: { productId: product.id } })).toBe(0);

    // Adding a size later: only the NEW variation gets a code; existing ones untouched.
    const before = Object.fromEntries(variations.map((v) => [v.id, v.barcodes[0].code]));
    const more = await generateProductVariationsAction({ productId: product.id, options: [{ name: "Taille", values: ["S", "M", "L", "XL"] }], generateBarcodes: true });
    expect(more.ok && more.data.barcodesGenerated).toBe(1);
    for (const [id, code] of Object.entries(before)) {
      expect((await prisma.barcode.findFirstOrThrow({ where: { variationId: id } })).code).toBe(code);
    }
  });

  it("Identité: each variation gets its own code through « Générer » + « Ajouter »", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const product = await variableProduct();
    await generateProductVariationsAction({ productId: product.id, options: SIZES });
    const variations = await prisma.productVariation.findMany({ orderBy: { sku: "asc" } });
    for (const v of variations) expect((await addBarcodeAction({ variationId: v.id, code: await generate() })).ok).toBe(true);
    const codes = (await prisma.barcode.findMany()).map((b) => b.code);
    expect(new Set(codes).size).toBe(variations.length);
  });

  it("skips numbers already used as a barcode (exact or GTIN-14 spelling) or as a product / variation SKU", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const p = await prisma.product.create({ data: { name: "Existant", sku: "2000000000015", price: 1, status: "ACTIF" } });
    const v = await variableProduct("PARENT");
    await prisma.productVariation.create({ data: { productId: v.id, sku: "2000000000022", attributes: {} } });
    await prisma.barcode.create({ data: { code: "2000000000039", productId: p.id } });
    const other = await prisma.product.create({ data: { name: "Autre", sku: "AUTRE", price: 1, status: "ACTIF" } });
    await prisma.barcode.create({ data: { code: "02000000000046", productId: other.id } }); // GTIN-14 spelling of …0046
    expect(await generate()).toBe("2000000000053");
  });

  it("the database still refuses a duplicate: a generated code already attached cannot be attached again", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const code = await generate();
    const a = await prisma.product.create({ data: { name: "A", sku: "A-1", price: 1, status: "ACTIF" } });
    const b = await prisma.product.create({ data: { name: "B", sku: "B-1", price: 1, status: "ACTIF" } });
    expect((await addBarcodeAction({ productId: a.id, code })).ok).toBe(true);
    const dup = await addBarcodeAction({ productId: b.id, code });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toMatch(/déjà utilisé/);
  });

  it("20 concurrent « Générer » get 20 distinct codes", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const codes = await Promise.all(Array.from({ length: 20 }, () => generate()));
    expect(new Set(codes).size).toBe(20);
    expect(codes.every(isGeneratedProductBarcode)).toBe(true);
  });

  it("concurrent variation generation on two products never shares a code", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const [p1, p2] = [await variableProduct("P-ONE"), await variableProduct("P-TWO")];
    const [r1, r2] = await Promise.all([
      generateProductVariationsAction({ productId: p1.id, options: SIZES, generateBarcodes: true }),
      generateProductVariationsAction({ productId: p2.id, options: SIZES, generateBarcodes: true }),
    ]);
    expect([r1, r2]).toEqual([
      { ok: true, data: { created: 3, skippedExisting: 0, barcodesGenerated: 3 } },
      { ok: true, data: { created: 3, skippedExisting: 0, barcodesGenerated: 3 } },
    ]);
    const codes = (await prisma.barcode.findMany()).map((b) => b.code);
    expect(codes).toHaveLength(6);
    expect(new Set(codes).size).toBe(6);
  });

  it("an existing barcode is never replaced: generating writes nothing by itself", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const p = await prisma.product.create({ data: { name: "Gardé", sku: "KEEP", price: 1, status: "ACTIF" } });
    await addBarcodeAction({ productId: p.id, code: "6111000000014" });
    await generate();
    const codes = await prisma.barcode.findMany({ where: { productId: p.id } });
    expect(codes.map((c) => [c.code, c.isPrimary])).toEqual([["6111000000014", true]]);
  });

  it("permissions: a role without products.create/edit is refused; an ONLINE_ONLY tenant has no barcodes", async () => {
    await loginAsTestUser({ role: "DELIVERY" });
    await expect(generateProductBarcodeAction()).rejects.toThrow(/non autorisé/i);
    await setTestBusinessMode("ONLINE_ONLY");
    await loginAsTestUser({ role: "OWNER" });
    await expect(generateProductBarcodeAction()).rejects.toThrow();
  });
});

describe("tenant isolation, scanning, export, backup", () => {
  it("each tenant has its own sequence; a code resolves only inside its tenant", async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    await setSwitch(true);
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "B", slug: TENANT_B } });
    await setTestBusinessMode("ONLINE_AND_OFFLINE", TENANT_B);
    await setSwitch(true, TENANT_B);

    await loginAsTestUser({ role: "OWNER" });
    const codeA = await generate();
    const pa = await prisma.product.create({ data: { name: "Produit A", sku: "PA", price: 1, status: "ACTIF" } });
    await addBarcodeAction({ productId: pa.id, code: codeA });

    await loginAsTestUser({ role: "OWNER", tenantId: TENANT_B });
    const codeB = await generate();
    expect(codeB).toBe(codeA); // both tenants start at 2000000000015
    expect(await lookupSellableUnits(prisma, codeA)).toEqual([]); // A's product is invisible in B
  });

  it("scanner / POS / search lookup resolves a generated code to the right product and variation", async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    await setSwitch(true);
    await loginAsTestUser({ role: "OWNER" });
    const simple = await prisma.product.create({ data: { name: "Simple", sku: "SIMPLE", price: 50, status: "ACTIF" } });
    const simpleCode = await generate();
    await addBarcodeAction({ productId: simple.id, code: simpleCode });
    const parent = await variableProduct();
    await generateProductVariationsAction({ productId: parent.id, options: SIZES, generateBarcodes: true });
    const variation = await prisma.productVariation.findFirstOrThrow({ where: { sku: { contains: "-M" } }, include: { barcodes: true } });

    const bySimple = await lookupSellableUnits(prisma, simpleCode);
    expect(bySimple.map((u) => [u.productId, u.variationId])).toEqual([[simple.id, null]]);
    const byVariation = await lookupSellableUnits(prisma, variation.barcodes[0].code);
    expect(byVariation.map((u) => u.variationId)).toEqual([variation.id]);
    expect(byVariation[0].primaryBarcode).toBe(variation.barcodes[0].code);
  });

  it("the store CSV export never writes a generated code as a GTIN; a real one is kept", () => {
    expect(exportableBarcode("2000000000015")).toBeNull();
    expect(exportableBarcode("6111000000014")).toBe("6111000000014");
    expect(exportableBarcode(null)).toBeNull();
  });

  it("backup/restore keeps generated codes and moves the counter past them", async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    await setSwitch(true);
    await loginAsTestUser({ role: "OWNER" });
    const parent = await variableProduct();
    await generateProductVariationsAction({ productId: parent.id, options: SIZES, generateBarcodes: true });
    const before = (await prisma.barcode.findMany({ orderBy: { code: "asc" } })).map((b) => b.code);
    const backup = await buildTenantBackup({ tenantId: DEFAULT_TENANT_ID, createdByUserId: null });
    await prismaBase.tenant.update({ where: { id: DEFAULT_TENANT_ID }, data: { nextProductBarcodeNumber: BigInt(1) } });

    await restoreTenantBackup({ activeTenantId: DEFAULT_TENANT_ID, inspected: inspectBackup(backup.container) });

    const after = await runWithTenant(DEFAULT_TENANT_ID, "test", async () =>
      (await prisma.barcode.findMany({ orderBy: { code: "asc" } })).map((b) => b.code)
    );
    expect(after).toEqual(before);
    expect((await prismaBase.tenant.findUniqueOrThrow({ where: { id: DEFAULT_TENANT_ID } })).nextProductBarcodeNumber).toBe(BigInt(4));
    expect(await generate()).toBe("2000000000046");
  });
});
