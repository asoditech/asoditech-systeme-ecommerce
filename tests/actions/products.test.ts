import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createProductAction, updateProductAction } from "@/actions/products";
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
