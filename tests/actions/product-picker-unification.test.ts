import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { searchProductsForOrderAction } from "@/actions/orders";
import { resolveTransferCodeAction } from "@/actions/transfers";
import { createStocktakeSessionAction, findStocktakeLineByCodeAction } from "@/actions/stocktakes";
import { lookupSellableUnitsAction } from "@/actions/catalog";
import { lookupSellableUnits } from "@/lib/catalog/lookup";
import { formatGeneratedProductBarcode } from "@/lib/catalog/generated-barcode";
import { DEFAULT_TENANT_ID, resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Product selection across the app (docs/adr/0061): the order picker, the
 * transfer picker and the stocktake finder resolve EXACT codes through the
 * shared resolver (src/lib/catalog/exact-code.ts) used by sales, receptions,
 * packing and returns — name / SKU / barcode (incl. generated internal codes)
 * search, exact variation resolution, no customer-code confusion, tenant
 * isolation, permissions. Interactive UI behaviour (picker staying open,
 * selections kept) has no DOM test tooling in this repo.
 */

const GEN_M = formatGeneratedProductBarcode(1); // 2000000000015
const TENANT_B = "tenant-b-pickers";

async function seedCatalog() {
  const warehouse = await prisma.warehouse.create({ data: { id: "wh-pick", name: "Entrepôt", isDefault: true } });
  const simple = await prisma.product.create({ data: { name: "Bougie ambrée", sku: "BOUGIE-1", price: 80, status: "ACTIF" } });
  await prisma.barcode.create({ data: { code: "6111000000014", productId: simple.id, isPrimary: true } });
  const shirt = await prisma.product.create({ data: { name: "T-shirt lin", sku: "TLIN", price: 150, status: "ACTIF" } });
  const [s, m, l] = await Promise.all(
    ["S", "M", "L"].map((size) =>
      prisma.productVariation.create({ data: { productId: shirt.id, sku: `TLIN-${size}`, attributes: { Taille: size }, isActive: size !== "L" } })
    )
  );
  await prisma.barcode.create({ data: { code: GEN_M, variationId: m.id, isPrimary: true } });
  await prisma.barcode.create({ data: { code: "2000000000022", variationId: l.id, isPrimary: true } }); // L is inactive
  await prisma.barcode.create({ data: { code: "012345678905", variationId: s.id, isPrimary: true } }); // UPC-A
  for (const row of [{ productId: simple.id }, { variationId: s.id }, { variationId: m.id }]) {
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, quantityOnHand: 5, ...row } });
  }
  // A customer whose code must never be taken for a product.
  await prisma.customer.create({ data: { fullName: "Client Code", barcode: "CL-000001" } });
  return { warehouse, simple, shirt, s, m, l };
}

const unitsOf = (results: Awaited<ReturnType<typeof searchProductsForOrderAction>>) =>
  results.flatMap((p) => (p.variations.length > 0 ? p.variations.map((v) => v.sku) : [p.sku])).sort();

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

describe("order picker (reference) — searchProductsForOrderAction", () => {
  it("searches by name, product SKU, variation SKU and option value", async () => {
    await loginAsTestUser({ role: "OWNER" });
    await seedCatalog();
    expect(unitsOf(await searchProductsForOrderAction("bougie"))).toEqual(["BOUGIE-1"]);
    expect(unitsOf(await searchProductsForOrderAction("BOUGIE-1"))).toEqual(["BOUGIE-1"]);
    expect(unitsOf(await searchProductsForOrderAction("TLIN-S"))).toEqual(["TLIN-S"]);
    expect(unitsOf(await searchProductsForOrderAction("lin"))).toEqual(["TLIN-M", "TLIN-S"]); // inactive L never offered
  });

  it("an exact barcode resolves to the exact unit: a variation's generated code offers THAT variation only", async () => {
    await loginAsTestUser({ role: "OWNER" });
    await seedCatalog();
    expect(unitsOf(await searchProductsForOrderAction(GEN_M))).toEqual(["TLIN-M"]);
    expect(unitsOf(await searchProductsForOrderAction("6111000000014"))).toEqual(["BOUGIE-1"]);
    // GTIN spelling of the stored UPC-A, as a 13-digit scanner sends it.
    expect(unitsOf(await searchProductsForOrderAction("0012345678905"))).toEqual(["TLIN-S"]);
  });

  it("a variable product's parent SKU (several units) still offers every active variation", async () => {
    await loginAsTestUser({ role: "OWNER" });
    await seedCatalog();
    expect(unitsOf(await searchProductsForOrderAction("TLIN"))).toEqual(["TLIN-M", "TLIN-S"]);
  });

  it("an exact code of an inactive variation / archived product offers nothing (no fuzzy fallback)", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const { simple } = await seedCatalog();
    expect(await searchProductsForOrderAction("2000000000022")).toEqual([]);
    await prisma.product.update({ where: { id: simple.id }, data: { status: "ARCHIVE" } });
    expect(await searchProductsForOrderAction("6111000000014")).toEqual([]);
  });

  it("a customer code never resolves as a product", async () => {
    await loginAsTestUser({ role: "OWNER" });
    await seedCatalog();
    expect(await searchProductsForOrderAction("CL-000001")).toEqual([]);
  });
});

describe("sale / reception / traceability picker — shared lookupSellableUnits", () => {
  it("same exact-variation resolution and no customer-code confusion", async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    await loginAsTestUser({ role: "OWNER" });
    const { m } = await seedCatalog();
    const byCode = await lookupSellableUnitsAction({ query: GEN_M });
    expect(byCode.map((u) => u.variationId)).toEqual([m.id]);
    expect(await lookupSellableUnits(prisma, "CL-000001")).toEqual([]);
  });
});

describe("transfer picker — resolveTransferCodeAction", () => {
  it("resolves a generated variation code, a simple product barcode and a variation SKU to the exact unit", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const { warehouse, simple, m, s } = await seedCatalog();
    const gen = await resolveTransferCodeAction({ warehouseId: warehouse.id, code: GEN_M });
    expect(gen.ok && gen.data).toMatchObject({ productId: expect.any(String), variationId: m.id });
    const ean = await resolveTransferCodeAction({ warehouseId: warehouse.id, code: "6111000000014" });
    expect(ean.ok && ean.data).toMatchObject({ productId: simple.id, variationId: null });
    const sku = await resolveTransferCodeAction({ warehouseId: warehouse.id, code: "tlin-s" });
    expect(sku.ok && sku.data.variationId).toBe(s.id);
  });

  it("refuses a parent SKU (ambiguous), an unknown code and a customer code", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const { warehouse } = await seedCatalog();
    const parent = await resolveTransferCodeAction({ warehouseId: warehouse.id, code: "TLIN" });
    expect(parent.ok).toBe(false);
    if (!parent.ok) expect(parent.error).toMatch(/ambigu/i);
    expect((await resolveTransferCodeAction({ warehouseId: warehouse.id, code: "9999999999999" })).ok).toBe(false);
    expect((await resolveTransferCodeAction({ warehouseId: warehouse.id, code: "CL-000001" })).ok).toBe(false);
  });

  it("needs inventory.transfer", async () => {
    await loginAsTestUser({ role: "CONFIRMATION" });
    await expect(resolveTransferCodeAction({ warehouseId: "", code: GEN_M })).rejects.toThrow(/non autorisé/i);
  });
});

describe("stocktake count finder — findStocktakeLineByCodeAction", () => {
  it("finds the line counting the scanned unit; refuses an article outside the session", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const { warehouse, m } = await seedCatalog();
    const session = await createStocktakeSessionAction({ warehouseId: warehouse.id, notes: "" });
    if (!session.ok) throw new Error(session.error);
    const found = await findStocktakeLineByCodeAction({ id: session.data.id, code: GEN_M });
    expect(found.ok).toBe(true);
    if (found.ok) {
      const line = await prisma.stocktakeLine.findUniqueOrThrow({ where: { id: found.data.lineId }, include: { inventoryItem: true } });
      expect(line.inventoryItem.variationId).toBe(m.id);
    }
    // L is inactive and has no stock row in this warehouse → not in the session.
    expect((await findStocktakeLineByCodeAction({ id: session.data.id, code: "2000000000022" })).ok).toBe(false);
    expect((await findStocktakeLineByCodeAction({ id: session.data.id, code: "CL-000001" })).ok).toBe(false);
  });
});

describe("tenant isolation", () => {
  it("another tenant's product codes are invisible to every picker", async () => {
    await loginAsTestUser({ role: "OWNER" });
    await seedCatalog();
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "B", slug: TENANT_B } });
    await loginAsTestUser({ role: "OWNER", tenantId: TENANT_B });
    expect(await searchProductsForOrderAction(GEN_M)).toEqual([]);
    expect(await searchProductsForOrderAction("bougie")).toEqual([]);
    const wh = await prisma.warehouse.create({ data: { name: "B", isDefault: true } });
    expect((await resolveTransferCodeAction({ warehouseId: wh.id, code: GEN_M })).ok).toBe(false);
    expect(DEFAULT_TENANT_ID).not.toBe(TENANT_B);
  });
});
