import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { createSession, getCurrentUser } from "@/lib/auth/session";
import { listExportCandidates, loadExportProducts } from "@/lib/catalog/export/load";
import { prepareProductExport } from "@/lib/catalog/export/service";
import { validateProductExportAction } from "@/actions/product-export";
import { removeProductAction, setProductActiveAction } from "@/actions/products";
import { POST as exportRoute } from "@/app/(protected)/produits/exporter/[platform]/route";
import { resetDb } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { RedirectSignal } from "../setup";

/** Product CSV export + product lifecycle — docs/adr/0054. */

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

async function as(role: "ADMIN" | "WAREHOUSE" | "MANAGER", tenantId?: string) {
  const u = await createTestUser({ role, ...(tenantId ? { tenantId } : {}) });
  mockCookieStore.clear();
  await createSession(u.id);
  await getCurrentUser();
  return u;
}
const fd = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
async function download(platform: string, ids: string[]) {
  const body = new FormData();
  for (const id of ids) body.append("ids", id);
  return exportRoute(new Request(`http://t/produits/exporter/${platform}`, { method: "POST", body }), { params: Promise.resolve({ platform }) });
}

/** A small catalogue: active simple + variable, a draft, an archived one, a store-imported one. */
async function catalogue() {
  const parent = await prisma.category.create({ data: { name: "Vêtements", slug: "vetements" } });
  const tees = await prisma.category.create({ data: { name: "T-Shirts", slug: "t-shirts", parentId: parent.id } });
  const wh = await prisma.warehouse.create({ data: { name: "Entrepôt", isDefault: true } });
  const simple = await prisma.product.create({
    data: {
      name: "Casquette",
      sku: "CAP-1",
      price: 80,
      status: "ACTIF",
      categoryId: tees.id,
      images: { create: [{ url: "https://cdn.example.com/cap.jpg", position: 0 }, { url: "https://cdn.example.com/cap-2.jpg", position: 1 }] },
    },
  });
  await prisma.barcode.create({ data: { code: "6111111111111", productId: simple.id, isPrimary: true } });
  await prisma.inventoryItem.create({ data: { warehouseId: wh.id, productId: simple.id, quantityOnHand: 4 } });
  const tee = await prisma.product.create({ data: { name: "T-Shirt « Été »", sku: "TEE", price: 100, status: "ACTIF", categoryId: tees.id } });
  await prisma.productVariation.create({ data: { productId: tee.id, sku: "TEE-S", attributes: { Taille: "S" }, price: 100 } });
  await prisma.productVariation.create({ data: { productId: tee.id, sku: "TEE-M", attributes: { Taille: "M" }, price: 110, imageUrl: "https://cdn.example.com/tee-m.jpg" } });
  const draft = await prisma.product.create({ data: { name: "Brouillon", sku: "DRAFT", price: 10, status: "BROUILLON" } });
  const archived = await prisma.product.create({ data: { name: "Ancien", sku: "OLD", price: 10, status: "ARCHIVE" } });
  const imported = await prisma.product.create({ data: { name: "Importé Woo", sku: "WOO-1", price: 10, status: "ACTIF", source: "WOOCOMMERCE", externalId: "77" } });
  return { parent, tees, wh, simple, tee, draft, archived, imported };
}

describe("filtering and selection", () => {
  it("default = ACTIVE products created in ASODITECH; filters narrow; inactive only when asked", async () => {
    const c = await catalogue();
    await as("ADMIN");
    const ids = async (f: Parameters<typeof listExportCandidates>[0]) => (await listExportCandidates(f)).rows.map((r) => r.id).sort();
    expect(await ids({})).toEqual([c.simple.id, c.tee.id].sort());
    expect(await ids({ status: "ARCHIVE" })).toEqual([c.archived.id]);
    expect(await ids({ status: "all" })).toEqual([c.simple.id, c.tee.id, c.draft.id, c.archived.id].sort());
    expect(await ids({ source: "all" })).toContain(c.imported.id);
    expect(await ids({ type: "variable" })).toEqual([c.tee.id]);
    expect(await ids({ type: "simple" })).toEqual([c.simple.id]);
    expect(await ids({ stock: "in" })).toEqual([c.simple.id]);
    expect(await ids({ stock: "out" })).toEqual([c.tee.id]);
    expect(await ids({ categoryId: c.parent.id })).toEqual([]);
    expect(await ids({ q: "TEE-M" })).toEqual([c.tee.id]); // variation SKU finds its parent
    expect(await ids({ createdFrom: "2000-01-01", createdTo: "2000-01-02" })).toEqual([]);
    await prisma.productPublication.create({ data: { productId: c.simple.id, provider: "WOOCOMMERCE", externalId: "999" } });
    expect(await ids({ notPublishedTo: "woocommerce" })).toEqual([c.tee.id]);
    expect((await listExportCandidates({})).rows[0]).toMatchObject({ name: "Casquette", imageCount: 2, variationCount: 0 });
  });

  it("selection loads exactly the chosen products, in a deterministic order, with category path and barcodes", async () => {
    const c = await catalogue();
    await as("ADMIN");
    const loaded = await loadExportProducts([c.tee.id, c.simple.id, c.tee.id]);
    expect(loaded.map((p) => p.name)).toEqual(["Casquette", "T-Shirt « Été »"]);
    expect(loaded[0]).toMatchObject({ categoryPath: ["Vêtements", "T-Shirts"], barcode: "6111111111111" });
    expect(loaded[1].variations.map((v) => v.sku)).toEqual(["TEE-S", "TEE-M"]);
  });
});

describe("download route", () => {
  it("WooCommerce and Shopify files: deterministic name, UTF-8, variations and images, audited", async () => {
    const c = await catalogue();
    const admin = await as("ADMIN");
    const woo = await download("woocommerce", [c.simple.id, c.tee.id]);
    expect(woo.status).toBe(200);
    expect(woo.headers.get("content-disposition")).toMatch(/filename="asoditech-woocommerce-products-\d{4}-\d{2}-\d{2}\.csv"/);
    const wooCsv = await woo.text();
    expect(wooCsv.split("\r\n")[0]).toMatch(/^Type,SKU,"GTIN, UPC, EAN, or ISBN",Name,/);
    expect(wooCsv).toContain("variation,TEE-M");
    expect(wooCsv).toContain("T-Shirt « Été »");
    expect(wooCsv).toContain("https://cdn.example.com/cap.jpg, https://cdn.example.com/cap-2.jpg");
    const shop = await download("shopify", [c.simple.id, c.tee.id]);
    expect(shop.headers.get("content-disposition")).toMatch(/asoditech-shopify-products-/);
    const shopCsv = await shop.text();
    expect(shopCsv.split("\r\n")[0].startsWith("Title,URL handle,Description")).toBe(true);
    expect(shopCsv).toContain("t-shirt-ete");
    const audit = await prismaBase.auditEvent.findMany({ where: { action: "product.exported" } });
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ actorUserId: admin.id });
  });

  it("validation failures and empty selection: no file (422), same result as the pre-check action", async () => {
    const c = await catalogue();
    await as("ADMIN");
    const empty = await download("woocommerce", []);
    expect(empty.status).toBe(422);
    expect(((await empty.json()) as { validation: { errors: { code: string }[] } }).validation.errors[0].code).toBe("empty");
    const imported = await download("woocommerce", [c.imported.id]);
    expect(imported.status).toBe(422);
    const check = await validateProductExportAction({ platform: "woocommerce", ids: [c.imported.id] });
    expect(check.ok && check.data.validation.errors.map((e) => e.code)).toContain("already_on_platform");
    expect((await download("tiktok", [c.simple.id])).status).toBe(404);
  });

  it("permission: products.edit is required for the route, the action and the page", async () => {
    const c = await catalogue();
    await as("WAREHOUSE"); // products.view without products.edit
    expect((await download("woocommerce", [c.simple.id])).status).toBe(403);
    await expect(validateProductExportAction({ platform: "woocommerce", ids: [c.simple.id] })).rejects.toThrow(/non autorisé/i);
    const { default: ExportPage } = await import("@/app/(protected)/produits/exporter/page");
    await expect(ExportPage({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(RedirectSignal);
    mockCookieStore.clear();
    expect((await download("woocommerce", [c.simple.id])).status).toBe(401);
  });

  it("tenant isolation: another tenant's product id is never exported", async () => {
    const c = await catalogue();
    await prismaBase.tenant.create({ data: { id: "tenant-b-0054", name: "B", slug: "tenant-b-0054" } });
    await as("ADMIN", "tenant-b-0054");
    expect((await listExportCandidates({ status: "all", source: "all" })).total).toBe(0);
    const res = await download("woocommerce", [c.simple.id]);
    expect(res.status).toBe(422);
    const prepared = await prepareProductExport("shopify", [c.simple.id]);
    expect(prepared.csv).toBeNull();
    expect(prepared.validation.errors.map((e) => e.code)).toEqual(expect.arrayContaining(["not_found"]));
  });
});

describe("product lifecycle", () => {
  it("deactivate / reactivate: audited, excluded from the default export, kept in history", async () => {
    const c = await catalogue();
    await as("MANAGER");
    expect((await setProductActiveAction(fd({ productId: c.simple.id, active: "0" }))).ok).toBe(true);
    expect((await prismaBase.product.findUniqueOrThrow({ where: { id: c.simple.id } })).status).toBe("ARCHIVE");
    expect((await listExportCandidates({})).rows.map((r) => r.id)).not.toContain(c.simple.id);
    expect(await prismaBase.auditEvent.count({ where: { action: "product.archived", entityId: c.simple.id } })).toBe(1);
    expect((await setProductActiveAction(fd({ productId: c.simple.id, active: "1" }))).ok).toBe(true);
    expect((await prismaBase.product.findUniqueOrThrow({ where: { id: c.simple.id } })).status).toBe("ACTIF");
    // a store-imported product's status belongs to the store sync
    expect((await setProductActiveAction(fd({ productId: c.imported.id, active: "0" }))).ok).toBe(false);
    await as("WAREHOUSE");
    await expect(setProductActiveAction(fd({ productId: c.simple.id, active: "0" }))).rejects.toThrow(/non autorisé/i);
  });

  it("remove: archives (never deletes) a product with a publication or a draft reception line; deletes a clean one", async () => {
    const c = await catalogue();
    await as("ADMIN");
    await prisma.productPublication.create({ data: { productId: c.tee.id, provider: "SHOPIFY", externalId: "gid://1" } });
    const supplier = await prisma.supplier.create({ data: { name: "F" } });
    await prisma.reception.create({
      data: { receptionNumber: 70, supplierId: supplier.id, warehouseId: c.wh.id, lines: { create: [{ productId: c.draft.id, nameSnapshot: "Brouillon", skuSnapshot: "DRAFT", quantity: 1, unitCost: 5 }] } },
    });
    const published = await removeProductAction(fd({ productId: c.tee.id }));
    expect(published.ok && published.data.deleted).toBe(false);
    expect(await prismaBase.productPublication.count({ where: { productId: c.tee.id } })).toBe(1);
    const received = await removeProductAction(fd({ productId: c.draft.id }));
    expect(received.ok && received.data.deleted).toBe(false);
    const clean = await prisma.product.create({ data: { name: "Erreur de saisie", sku: "OOPS", price: 1 } });
    const removed = await removeProductAction(fd({ productId: clean.id }));
    expect(removed.ok && removed.data.deleted).toBe(true);
  });
});
