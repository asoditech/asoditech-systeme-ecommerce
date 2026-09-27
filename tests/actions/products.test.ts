import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createProductAction,
  updateProductAction,
  updateProductOperationalSettingsAction,
  createProductVariationAction,
  backfillProductCostSnapshotsAction,
  removeProductAction,
  updateCategoryAction,
  generateProductVariationsAction,
  updateVariationDetailsAction,
  updateVariationSkuAction,
  removeVariationAction,
  addProductImageAction,
  removeProductImageAction,
  setPrimaryProductImageAction,
} from "@/actions/products";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe("backfillProductCostSnapshotsAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("fills a null costSnapshot on past sales with the current cost, skipping cancelled orders and priced lines", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const customer = await prisma.customer.create({ data: { fullName: "C" } });
    const product = await prisma.product.create({ data: { name: "P", sku: "BF-1", price: 150, cost: 70, status: "ACTIF" } });

    const sold = await prisma.order.create({
      data: {
        customerId: customer.id,
        status: "LIVREE",
        subtotal: 300,
        total: 300,
        currency: "MAD",
        items: {
          create: [
            { productId: product.id, nameSnapshot: "P", skuSnapshot: "BF-1", unitPrice: 150, quantity: 1, total: 150, costSnapshot: null },
            { productId: product.id, nameSnapshot: "P", skuSnapshot: "BF-1", unitPrice: 150, quantity: 1, total: 150, costSnapshot: 55 },
          ],
        },
      },
      include: { items: true },
    });
    const cancelled = await prisma.order.create({
      data: {
        customerId: customer.id,
        status: "ANNULEE",
        subtotal: 150,
        total: 150,
        currency: "MAD",
        items: { create: { productId: product.id, nameSnapshot: "P", skuSnapshot: "BF-1", unitPrice: 150, quantity: 1, total: 150, costSnapshot: null } },
      },
      include: { items: true },
    });

    const res = await backfillProductCostSnapshotsAction(formData({ productId: product.id }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.updated).toBe(1);

    const filled = await prisma.orderItem.findUniqueOrThrow({ where: { id: sold.items.find((i) => i.costSnapshot === null)!.id } });
    expect(Number(filled.costSnapshot)).toBe(70);
    const untouched = await prisma.orderItem.findUniqueOrThrow({ where: { id: sold.items.find((i) => Number(i.costSnapshot) === 55)!.id } });
    expect(Number(untouched.costSnapshot)).toBe(55);
    const cancelledLine = await prisma.orderItem.findFirstOrThrow({ where: { orderId: cancelled.id } });
    expect(cancelledLine.costSnapshot).toBeNull();
  });

  it("refuses when no cost is set on the product", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const product = await prisma.product.create({ data: { name: "P", sku: "BF-2", price: 100, cost: null, status: "ACTIF" } });
    const res = await backfillProductCostSnapshotsAction(formData({ productId: product.id }));
    expect(res.ok).toBe(false);
  });
});

describe("removeProductAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("hard-deletes a product that was never sold", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const product = await prisma.product.create({ data: { name: "Test", sku: "RM-1", price: 10, status: "ACTIF", source: "WOOCOMMERCE", externalId: "1" } });
    const res = await removeProductAction(formData({ productId: product.id }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.deleted).toBe(true);
    expect(await prisma.product.findUnique({ where: { id: product.id } })).toBeNull();
  });

  it("archives a product that has order history", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const customer = await prisma.customer.create({ data: { fullName: "C" } });
    const product = await prisma.product.create({ data: { name: "Sold", sku: "RM-2", price: 10, status: "ACTIF" } });
    await prisma.order.create({
      data: {
        customerId: customer.id,
        status: "LIVREE",
        subtotal: 10,
        total: 10,
        currency: "MAD",
        items: { create: { productId: product.id, nameSnapshot: "Sold", skuSnapshot: "RM-2", unitPrice: 10, quantity: 1, total: 10 } },
      },
    });
    const res = await removeProductAction(formData({ productId: product.id }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.deleted).toBe(false);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.status).toBe("ARCHIVE");
  });

  it("requires products.edit", async () => {
    await loginAsTestUser({ role: "SUPPORT" });
    const product = await prisma.product.create({ data: { name: "X", sku: "RM-3", price: 10, status: "ACTIF" } });
    await expect(removeProductAction(formData({ productId: product.id }))).rejects.toThrow();
  });
});

describe("createProductAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
    await prisma.warehouse.create({ data: { id: "default-warehouse", name: "Entrepôt principal", isDefault: true } });
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("rejects a caller without products.create permission", async () => {
    await loginAsTestUser({ role: "SUPPORT" });
    await expect(
      createProductAction(formData({ name: "Coffret", sku: "SKU-1", price: "100" }))
    ).rejects.toThrow(/non autorisé/i);
  });

  it("creates a product and an inventory item in the default warehouse", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const result = await createProductAction(
      formData({ name: "Coffret Thé", sku: "THE-001", price: "250", trackInventory: "on" })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const item = await prisma.inventoryItem.findFirst({ where: { productId: result.data.id } });
    expect(item).toBeTruthy();
    expect(item?.quantityOnHand).toBe(0);
  });

  it("does not create an inventory item when trackInventory is off", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const result = await createProductAction(
      formData({ name: "Service", sku: "SRV-001", price: "100" })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const item = await prisma.inventoryItem.findFirst({ where: { productId: result.data.id } });
    expect(item).toBeNull();
  });

  it("rejects a duplicate SKU", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    await createProductAction(formData({ name: "Produit A", sku: "DUP-1", price: "10" }));
    const result = await createProductAction(formData({ name: "Produit B", sku: "DUP-1", price: "20" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors?.sku).toBeTruthy();
  });

  it("rejects a duplicate SKU even when both requests race past the pre-check simultaneously (audit fix)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    // Both requests see no existing SKU via the findUnique pre-check before
    // either commits — only the DB's unique constraint (surfaced as P2002,
    // converted to a friendly error via isUniqueConstraintError) can catch
    // this. A stale-read pre-check alone would let both through.
    const [first, second] = await Promise.all([
      createProductAction(formData({ name: "Produit A", sku: "RACE-SKU-1", price: "10" })),
      createProductAction(formData({ name: "Produit B", sku: "RACE-SKU-1", price: "20" })),
    ]);
    const results = [first, second];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);

    const products = await prisma.product.findMany({ where: { sku: "RACE-SKU-1" } });
    expect(products).toHaveLength(1);
  });

  it("rejects a sale price above the regular price (audit fix)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const result = await createProductAction(
      formData({ name: "Coffret", sku: "SALE-1", price: "100", salePrice: "150" })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors?.salePrice).toBeTruthy();
  });

  // Batch 3, Task 2 — pasted image URL on the create form.
  it("persists a pasted image URL as the product's lead (position 0) image", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const result = await createProductAction(
      formData({ name: "Robe", sku: "IMG-1", price: "100", imageUrl: "https://example.com/robe.jpg" })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const image = await prisma.productImage.findFirst({ where: { productId: result.data.id } });
    expect(image?.url).toBe("https://example.com/robe.jpg");
    expect(image?.position).toBe(0);
  });

  it("creates the product with no image row when imageUrl is left empty", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const result = await createProductAction(formData({ name: "Jupe", sku: "IMG-2", price: "80" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const image = await prisma.productImage.findFirst({ where: { productId: result.data.id } });
    expect(image).toBeNull();
  });

  it("rejects a non-http(s) image URL and still creates nothing", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const result = await createProductAction(
      formData({ name: "Pull", sku: "IMG-3", price: "90", imageUrl: "javascript:alert(1)" })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors?.imageUrl).toBeTruthy();
    expect(await prisma.product.findFirst({ where: { sku: "IMG-3" } })).toBeNull();
  });
});

describe("updateProductAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
    await prisma.warehouse.create({ data: { id: "default-warehouse", name: "Entrepôt principal", isDefault: true } });
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("records product.archived when status flips to ARCHIVE", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const created = await createProductAction(formData({ name: "Produit A", sku: "ARC-1", price: "10", status: "ACTIF" }));
    if (!created.ok) throw new Error("setup failed");

    await updateProductAction(
      formData({ id: created.data.id, name: "Produit A", sku: "ARC-1", price: "10", status: "ARCHIVE" })
    );

    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "product.archived", entityId: created.data.id },
    });
    expect(audit).toBeTruthy();
  });
});

/**
 * Phase 28 — docs/adr/0017-product-management-boundary.md. Product
 * *definition* is owned by whichever platform an externally-sourced
 * product actually lives on; these actions must refuse to touch it
 * regardless of what the UI does or doesn't show, exactly like every
 * other "the real enforcement point is the server action" boundary in
 * this codebase.
 */
describe("product management boundary (Phase 28)", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
    await prisma.warehouse.create({ data: { id: "default-warehouse", name: "Entrepôt principal", isDefault: true } });
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  async function seedExternalProduct(source: "WOOCOMMERCE" | "SHOPIFY" = "WOOCOMMERCE") {
    return prisma.product.create({
      data: { name: "Tablier importé", sku: `EXT-${source}-1`, price: 100, source, externalId: "501" },
    });
  }

  describe("updateProductAction", () => {
    it("rejects editing a WooCommerce-sourced product's definition", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const product = await seedExternalProduct("WOOCOMMERCE");

      const result = await updateProductAction(
        formData({ id: product.id, name: "Nom modifié depuis ASODITECH", sku: product.sku, price: "999" })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/WooCommerce/);

      const unchanged = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(unchanged.name).toBe("Tablier importé");
      expect(Number(unchanged.price)).toBe(100);
    });

    it("rejects editing a Shopify-sourced product's definition", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const product = await seedExternalProduct("SHOPIFY");

      const result = await updateProductAction(
        formData({ id: product.id, name: "Nom modifié", sku: product.sku, price: "999" })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/Shopify/);
    });

    it("still allows editing a genuinely internal product", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const created = await createProductAction(formData({ name: "Produit interne", sku: "INT-1", price: "50" }));
      if (!created.ok) throw new Error("setup failed");

      const result = await updateProductAction(
        formData({ id: created.data.id, name: "Produit interne modifié", sku: "INT-1", price: "60" })
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("createProductVariationAction", () => {
    it("rejects creating a new variation on an externally-sourced product", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const product = await seedExternalProduct("SHOPIFY");

      const result = await createProductVariationAction(
        formData({ productId: product.id, sku: "VAR-1", attributes: JSON.stringify({ Couleur: "Rouge" }) })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/Shopify/);

      expect(await prisma.productVariation.count({ where: { productId: product.id } })).toBe(0);
    });

    it("still allows adding a variation to an internal product", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const created = await createProductAction(formData({ name: "Produit interne", sku: "INT-2", price: "50" }));
      if (!created.ok) throw new Error("setup failed");

      const result = await createProductVariationAction(
        formData({ productId: created.data.id, sku: "INT-2-VAR", attributes: JSON.stringify({ Taille: "M" }) })
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("updateProductOperationalSettingsAction", () => {
    it("updates cost/trackInventory/lowStockThreshold on an externally-sourced product", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const product = await seedExternalProduct("WOOCOMMERCE");

      const result = await updateProductOperationalSettingsAction(
        formData({ id: product.id, cost: "42", lowStockThreshold: "3", trackInventory: "on" })
      );
      expect(result.ok).toBe(true);

      const updated = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(Number(updated.cost)).toBe(42);
      expect(updated.lowStockThreshold).toBe(3);
      // Product definition must remain completely untouched by this action.
      expect(updated.name).toBe("Tablier importé");
      expect(Number(updated.price)).toBe(100);
    });

    it("also works for an internal product", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const created = await createProductAction(formData({ name: "Produit interne", sku: "INT-3", price: "50" }));
      if (!created.ok) throw new Error("setup failed");

      const result = await updateProductOperationalSettingsAction(
        formData({ id: created.data.id, cost: "10", lowStockThreshold: "2" })
      );
      expect(result.ok).toBe(true);
    });

    it("rejects a caller without products.edit permission", async () => {
      await loginAsTestUser({ role: "SUPPORT" });
      const product = await seedExternalProduct();
      await expect(
        updateProductOperationalSettingsAction(formData({ id: product.id, cost: "10" }))
      ).rejects.toThrow(/non autorisé/i);
    });
  });
});

// Batch 3, Task 1 — /catalogue/categories management page's write side.
describe("updateCategoryAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("rejects a caller without products.edit permission", async () => {
    await loginAsTestUser({ role: "SUPPORT" });
    const category = await prisma.category.create({ data: { name: "Chaussures", slug: "chaussures" } });
    await expect(
      updateCategoryAction(formData({ id: category.id, name: "Bottes", slug: "bottes" }))
    ).rejects.toThrow(/non autorisé/i);
  });

  it("updates name/slug/description on an INTERNE category", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const category = await prisma.category.create({ data: { name: "Chaussures", slug: "chaussures" } });

    const result = await updateCategoryAction(
      formData({ id: category.id, name: "Chaussures Homme", slug: "chaussures-homme", description: "Rayon homme" })
    );
    expect(result.ok).toBe(true);

    const updated = await prisma.category.findUniqueOrThrow({ where: { id: category.id } });
    expect(updated.name).toBe("Chaussures Homme");
    expect(updated.slug).toBe("chaussures-homme");
    expect(updated.description).toBe("Rayon homme");
  });

  it("refuses to edit a category synced from WooCommerce (provider-owned boundary)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const category = await prisma.category.create({
      data: { name: "Imported", slug: "imported", source: "WOOCOMMERCE", externalId: "77" },
    });

    const result = await updateCategoryAction(formData({ id: category.id, name: "Renamed", slug: "renamed" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/WooCommerce/);

    const untouched = await prisma.category.findUniqueOrThrow({ where: { id: category.id } });
    expect(untouched.name).toBe("Imported");
  });

  it("rejects a slug already used by another category", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    await prisma.category.create({ data: { name: "Robes", slug: "robes" } });
    const category = await prisma.category.create({ data: { name: "Jupes", slug: "jupes" } });

    const result = await updateCategoryAction(formData({ id: category.id, name: "Jupes", slug: "robes" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors?.slug).toBeTruthy();
  });

  it("refuses to make a category its own parent", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const category = await prisma.category.create({ data: { name: "Accessoires", slug: "accessoires" } });

    const result = await updateCategoryAction(
      formData({ id: category.id, name: "Accessoires", slug: "accessoires", parentId: category.id })
    );
    expect(result.ok).toBe(false);
  });

  it("returns 'catégorie introuvable' for an unknown id", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const result = await updateCategoryAction(formData({ id: "does-not-exist", name: "X", slug: "x" }));
    expect(result.ok).toBe(false);
  });
});

// Batch 4 — Variant System Rebuild.
describe("generateProductVariationsAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
    await prisma.warehouse.create({ data: { id: "default-warehouse", name: "Entrepôt principal", isDefault: true } });
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  async function seedProduct(overrides: Partial<{ reference: string | null; source: "INTERNE" | "WOOCOMMERCE" }> = {}) {
    return prisma.product.create({
      data: {
        name: "T-Shirt Badyss Classic",
        sku: `TSH-${Math.random()}`,
        reference: overrides.reference ?? "TSH-BADYSS",
        price: 150,
        status: "ACTIF",
        source: overrides.source ?? "INTERNE",
        externalId: overrides.source === "WOOCOMMERCE" ? "9001" : null,
      },
    });
  }

  it("creates 2×3=6 variations with server-suggested, unique SKUs and their own InventoryItem", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const product = await seedProduct();

    const result = await generateProductVariationsAction({
      productId: product.id,
      options: [
        { name: "Couleur", values: ["Noir", "Blanc"] },
        { name: "Taille", values: ["S", "M", "L"] },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ created: 6, skippedExisting: 0 });

    const variations = await prisma.productVariation.findMany({ where: { productId: product.id } });
    expect(variations).toHaveLength(6);
    expect(variations.map((v) => v.sku).sort()).toEqual(
      ["TSH-BADYSS-NOIR-S", "TSH-BADYSS-NOIR-M", "TSH-BADYSS-NOIR-L", "TSH-BADYSS-BLANC-S", "TSH-BADYSS-BLANC-M", "TSH-BADYSS-BLANC-L"].sort()
    );
    for (const v of variations) {
      const item = await prisma.inventoryItem.findFirst({ where: { variationId: v.id } });
      expect(item).toBeTruthy();
      expect(item?.quantityOnHand).toBe(0);
    }
  });

  it("regenerating does not duplicate existing combinations and does not touch them", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const product = await seedProduct();

    const first = await generateProductVariationsAction({
      productId: product.id,
      options: [{ name: "Taille", values: ["S", "M"] }],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.created).toBe(2);
    const existing = await prisma.productVariation.findFirst({ where: { productId: product.id, sku: { contains: "-S" } } });

    // Manually mark it as inventory-bearing / edited, to prove regeneration never touches it.
    await prisma.productVariation.update({ where: { id: existing!.id }, data: { cost: 42 } });

    const second = await generateProductVariationsAction({
      productId: product.id,
      options: [{ name: "Taille", values: ["S", "M", "L"] }], // S and M already exist, only L is new
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data).toEqual({ created: 1, skippedExisting: 2 });

    const all = await prisma.productVariation.findMany({ where: { productId: product.id } });
    expect(all).toHaveLength(3); // no duplicates
    const untouched = await prisma.productVariation.findUniqueOrThrow({ where: { id: existing!.id } });
    expect(Number(untouched.cost)).toBe(42); // never overwritten
  });

  it("an inventory-bearing existing variation is never deleted by regenerating with a narrower option set", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const product = await seedProduct();
    await generateProductVariationsAction({ productId: product.id, options: [{ name: "Taille", values: ["S", "M", "L"] }] });
    const beforeCount = await prisma.productVariation.count({ where: { productId: product.id } });
    expect(beforeCount).toBe(3);

    // Regenerating with only "S" must never remove M/L.
    const result = await generateProductVariationsAction({ productId: product.id, options: [{ name: "Taille", values: ["S"] }] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ created: 0, skippedExisting: 1 });
    expect(await prisma.productVariation.count({ where: { productId: product.id } })).toBe(3);
  });

  it("refuses to generate variations for a WooCommerce-sourced product (provider-owned boundary)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const product = await seedProduct({ source: "WOOCOMMERCE" });

    const result = await generateProductVariationsAction({
      productId: product.id,
      options: [{ name: "Taille", values: ["S", "M"] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/WooCommerce/);
    expect(await prisma.productVariation.count({ where: { productId: product.id } })).toBe(0);
  });

  it("rejects a caller without products.edit permission", async () => {
    await loginAsTestUser({ role: "SUPPORT" });
    const product = await seedProduct();
    await expect(
      generateProductVariationsAction({ productId: product.id, options: [{ name: "Taille", values: ["S"] }] })
    ).rejects.toThrow(/non autorisé/i);
  });
});

describe("updateVariationDetailsAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  async function seedVariation(overrides: Partial<{ price: number | null; productPrice: number }> = {}) {
    const product = await prisma.product.create({
      data: { name: "T-Shirt", sku: `TSH-${Math.random()}`, price: overrides.productPrice ?? 150, status: "ACTIF" },
    });
    const variation = await prisma.productVariation.create({
      data: { productId: product.id, sku: `TSH-V-${Math.random()}`, attributes: { Taille: "M" }, price: overrides.price },
    });
    return { product, variation };
  }

  it("sets cost, salePrice, imageUrl and isActive", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { variation } = await seedVariation();

    const result = await updateVariationDetailsAction(
      formData({ id: variation.id, cost: "60", salePrice: "120", imageUrl: "https://example.com/v.jpg", isActive: "false" })
    );
    expect(result.ok).toBe(true);

    const updated = await prisma.productVariation.findUniqueOrThrow({ where: { id: variation.id } });
    expect(Number(updated.cost)).toBe(60);
    expect(Number(updated.salePrice)).toBe(120);
    expect(updated.imageUrl).toBe("https://example.com/v.jpg");
    expect(updated.isActive).toBe(false);
  });

  it("rejects a sale price above the variation's own regular price", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { variation } = await seedVariation({ price: 100, productPrice: 150 });

    const result = await updateVariationDetailsAction(formData({ id: variation.id, salePrice: "120" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors?.salePrice).toBeTruthy();
  });

  it("falls back to the product's price as the ceiling when the variation has no price override", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { variation } = await seedVariation({ price: null, productPrice: 150 });

    const okResult = await updateVariationDetailsAction(formData({ id: variation.id, salePrice: "140" }));
    expect(okResult.ok).toBe(true);

    const tooHigh = await updateVariationDetailsAction(formData({ id: variation.id, salePrice: "160" }));
    expect(tooHigh.ok).toBe(false);
  });

  it("works on a WooCommerce-sourced variation (ASODITECH-owned fields, no provider guard)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const product = await prisma.product.create({
      data: { name: "Importé", sku: `EXT-${Math.random()}`, price: 100, source: "WOOCOMMERCE", externalId: "1" },
    });
    const variation = await prisma.productVariation.create({
      data: { productId: product.id, sku: `EXT-V-${Math.random()}`, attributes: { Taille: "M" }, source: "WOOCOMMERCE", externalId: "1-v" },
    });
    const result = await updateVariationDetailsAction(formData({ id: variation.id, isActive: "false" }));
    expect(result.ok).toBe(true);
    expect((await prisma.productVariation.findUniqueOrThrow({ where: { id: variation.id } })).isActive).toBe(false);
  });

  it("rejects a caller without products.edit permission", async () => {
    await loginAsTestUser({ role: "SUPPORT" });
    const { variation } = await seedVariation();
    await expect(updateVariationDetailsAction(formData({ id: variation.id, isActive: "true" }))).rejects.toThrow(/non autorisé/i);
  });
});

describe("removeVariationAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("hard-deletes an unused INTERNE variation", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const product = await prisma.product.create({ data: { name: "P", sku: `P-${Math.random()}`, price: 100, status: "ACTIF" } });
    const variation = await prisma.productVariation.create({
      data: { productId: product.id, sku: `P-V-${Math.random()}`, attributes: { Taille: "M" } },
    });

    const result = await removeVariationAction(formData({ id: variation.id }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.deleted).toBe(true);
    expect(await prisma.productVariation.findUnique({ where: { id: variation.id } })).toBeNull();
  });

  it("deactivates (never deletes) a variation that has stock movement history", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt", isDefault: true } });
    const product = await prisma.product.create({ data: { name: "P", sku: `P-${Math.random()}`, price: 100, status: "ACTIF" } });
    const variation = await prisma.productVariation.create({
      data: { productId: product.id, sku: `P-V-${Math.random()}`, attributes: { Taille: "M" } },
    });
    const item = await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, variationId: variation.id, quantityOnHand: 5 } });
    await prisma.inventoryMovement.create({
      data: { inventoryItemId: item.id, warehouseId: warehouse.id, type: "RECEPTION", quantity: 5 },
    });

    const result = await removeVariationAction(formData({ id: variation.id }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.deleted).toBe(false);

    const stillThere = await prisma.productVariation.findUniqueOrThrow({ where: { id: variation.id } });
    expect(stillThere.isActive).toBe(false);
    // The movement itself is completely untouched.
    expect(await prisma.inventoryMovement.count({ where: { inventoryItemId: item.id } })).toBe(1);
  });

  it("never hard-deletes a WooCommerce-sourced variation — only deactivates it", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const product = await prisma.product.create({
      data: { name: "Importé", sku: `EXT-${Math.random()}`, price: 100, source: "WOOCOMMERCE", externalId: "1" },
    });
    const variation = await prisma.productVariation.create({
      data: { productId: product.id, sku: `EXT-V-${Math.random()}`, attributes: { Taille: "M" }, source: "WOOCOMMERCE", externalId: "1-v" },
    });

    const result = await removeVariationAction(formData({ id: variation.id }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.deleted).toBe(false);
    const stillThere = await prisma.productVariation.findUniqueOrThrow({ where: { id: variation.id } });
    expect(stillThere.isActive).toBe(false);
  });

  it("rejects a caller without products.edit permission", async () => {
    await loginAsTestUser({ role: "SUPPORT" });
    const product = await prisma.product.create({ data: { name: "P", sku: `P-${Math.random()}`, price: 100, status: "ACTIF" } });
    const variation = await prisma.productVariation.create({
      data: { productId: product.id, sku: `P-V-${Math.random()}`, attributes: { Taille: "M" } },
    });
    await expect(removeVariationAction(formData({ id: variation.id }))).rejects.toThrow(/non autorisé/i);
  });
});

describe("updateVariationSkuAction (Batch 11)", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  async function seedVariation(overrides: Partial<{ source: "INTERNE" | "WOOCOMMERCE" }> = {}) {
    const product = await prisma.product.create({
      data: {
        name: "T-Shirt",
        sku: `TSH-${Math.random()}`,
        price: 150,
        status: "ACTIF",
        source: overrides.source ?? "INTERNE",
        externalId: overrides.source === "WOOCOMMERCE" ? "9001" : null,
      },
    });
    const variation = await prisma.productVariation.create({
      data: {
        productId: product.id,
        sku: `TSH-V-${Math.random()}`,
        attributes: { Taille: "M" },
        source: overrides.source ?? "INTERNE",
        externalId: overrides.source === "WOOCOMMERCE" ? "9001-v" : null,
      },
    });
    return { product, variation };
  }

  it("updates the SKU of an INTERNE variation", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { variation } = await seedVariation();

    const result = await updateVariationSkuAction({ id: variation.id, sku: "NEW-SKU-1" });
    expect(result.ok).toBe(true);
    expect((await prisma.productVariation.findUniqueOrThrow({ where: { id: variation.id } })).sku).toBe("NEW-SKU-1");
  });

  it("is a no-op ok when the submitted SKU is unchanged", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { variation } = await seedVariation();

    const result = await updateVariationSkuAction({ id: variation.id, sku: variation.sku });
    expect(result.ok).toBe(true);
  });

  it("rejects a SKU already used by another product", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { variation } = await seedVariation();
    const other = await prisma.product.create({ data: { name: "Autre", sku: "TAKEN-SKU", price: 50, status: "ACTIF" } });

    const result = await updateVariationSkuAction({ id: variation.id, sku: other.sku });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors?.sku).toBeTruthy();
    expect((await prisma.productVariation.findUniqueOrThrow({ where: { id: variation.id } })).sku).not.toBe(other.sku);
  });

  it("rejects a SKU already used by a sibling variation", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { product, variation } = await seedVariation();
    const sibling = await prisma.productVariation.create({
      data: { productId: product.id, sku: "SIBLING-SKU", attributes: { Taille: "L" } },
    });

    const result = await updateVariationSkuAction({ id: variation.id, sku: sibling.sku });
    expect(result.ok).toBe(false);
  });

  it("rejects a SKU already used by a barcode", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { variation } = await seedVariation();
    await prisma.barcode.create({ data: { code: "BARCODE-AS-SKU", productId: (await prisma.product.create({ data: { name: "X", sku: `X-${Math.random()}`, price: 1, status: "ACTIF" } })).id } });

    const result = await updateVariationSkuAction({ id: variation.id, sku: "BARCODE-AS-SKU" });
    expect(result.ok).toBe(false);
  });

  it("refuses to edit the SKU of a WooCommerce-sourced variation", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { variation } = await seedVariation({ source: "WOOCOMMERCE" });

    const result = await updateVariationSkuAction({ id: variation.id, sku: "SHOULD-NOT-APPLY" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/WooCommerce/);
    expect((await prisma.productVariation.findUniqueOrThrow({ where: { id: variation.id } })).sku).not.toBe("SHOULD-NOT-APPLY");
  });

  it("rejects a caller without products.edit permission", async () => {
    await loginAsTestUser({ role: "SUPPORT" });
    const { variation } = await seedVariation();
    await expect(updateVariationSkuAction({ id: variation.id, sku: "X-NEW" })).rejects.toThrow(/non autorisé/i);
  });
});

describe("product image gallery actions (Batch 11)", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  async function seedProduct(overrides: Partial<{ source: "INTERNE" | "WOOCOMMERCE" }> = {}) {
    return prisma.product.create({
      data: {
        name: "Produit",
        sku: `P-${Math.random()}`,
        price: 100,
        status: "ACTIF",
        source: overrides.source ?? "INTERNE",
        externalId: overrides.source === "WOOCOMMERCE" ? "1" : null,
      },
    });
  }

  it("addProductImageAction: the first image added becomes position 0 (primary)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const product = await seedProduct();

    const result = await addProductImageAction({ productId: product.id, imageUrl: "https://example.com/a.jpg" });
    expect(result.ok).toBe(true);
    const images = await prisma.productImage.findMany({ where: { productId: product.id } });
    expect(images).toHaveLength(1);
    expect(images[0].position).toBe(0);
  });

  it("addProductImageAction: a second image is appended after the last position, never overwriting it", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const product = await seedProduct();
    await addProductImageAction({ productId: product.id, imageUrl: "https://example.com/a.jpg" });

    const result = await addProductImageAction({ productId: product.id, imageUrl: "https://example.com/b.jpg" });
    expect(result.ok).toBe(true);
    const images = await prisma.productImage.findMany({ where: { productId: product.id }, orderBy: { position: "asc" } });
    expect(images).toHaveLength(2);
    expect(images[0].url).toBe("https://example.com/a.jpg");
    expect(images[0].position).toBe(0);
    expect(images[1].url).toBe("https://example.com/b.jpg");
    expect(images[1].position).toBe(1);
  });

  it("addProductImageAction: rejects an empty/invalid URL and a WooCommerce-sourced product", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const product = await seedProduct();
    const badUrl = await addProductImageAction({ productId: product.id, imageUrl: "" });
    expect(badUrl.ok).toBe(false);

    const external = await seedProduct({ source: "WOOCOMMERCE" });
    const result = await addProductImageAction({ productId: external.id, imageUrl: "https://example.com/a.jpg" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/WooCommerce/);
  });

  it("removeProductImageAction: removes exactly the targeted image, leaving others untouched", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const product = await seedProduct();
    await addProductImageAction({ productId: product.id, imageUrl: "https://example.com/a.jpg" });
    const b = await addProductImageAction({ productId: product.id, imageUrl: "https://example.com/b.jpg" });
    if (!b.ok) throw new Error("setup failed");

    const result = await removeProductImageAction({ id: b.data.id });
    expect(result.ok).toBe(true);
    const images = await prisma.productImage.findMany({ where: { productId: product.id } });
    expect(images).toHaveLength(1);
    expect(images[0].url).toBe("https://example.com/a.jpg");
  });

  it("setPrimaryProductImageAction: swaps positions so the chosen image becomes 0", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const product = await seedProduct();
    await addProductImageAction({ productId: product.id, imageUrl: "https://example.com/a.jpg" });
    const b = await addProductImageAction({ productId: product.id, imageUrl: "https://example.com/b.jpg" });
    if (!b.ok) throw new Error("setup failed");

    const result = await setPrimaryProductImageAction({ id: b.data.id });
    expect(result.ok).toBe(true);
    const images = await prisma.productImage.findMany({ where: { productId: product.id }, orderBy: { position: "asc" } });
    expect(images[0].url).toBe("https://example.com/b.jpg");
    expect(images[0].position).toBe(0);
    expect(images[1].url).toBe("https://example.com/a.jpg");
    expect(images[1].position).toBe(1);
  });

  it("rejects gallery mutations for a caller without products.edit permission", async () => {
    await loginAsTestUser({ role: "SUPPORT" });
    const product = await seedProduct();
    await expect(addProductImageAction({ productId: product.id, imageUrl: "https://example.com/a.jpg" })).rejects.toThrow(/non autorisé/i);
  });
});
