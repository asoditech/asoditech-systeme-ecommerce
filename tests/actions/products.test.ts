import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createProductAction,
  updateProductAction,
  updateProductOperationalSettingsAction,
  createProductVariationAction,
} from "@/actions/products";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

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
