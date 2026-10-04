import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { createProductAction, suggestProductReferenceAction, suggestProductSkuAction } from "@/actions/products";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * « Générer » server suggestions: next free sequence in THIS tenant, nothing
 * written, permission unchanged, creation's own uniqueness check still final.
 */

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  await setTestBusinessMode("ONLINE_AND_OFFLINE");
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

const value = (r: { ok: boolean; data?: { value: string } }) => (r.ok ? r.data!.value : null);

describe("suggestProductSkuAction", () => {
  it("SKU-HC-0001 first, then skips SKUs used by products, variations AND barcodes of this tenant", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    expect(value(await suggestProductSkuAction({ name: "Hoodie cachmir" }))).toBe("SKU-HC-0001");

    const p = await prisma.product.create({ data: { name: "x", sku: "SKU-HC-0001", price: 1 } });
    await prisma.productVariation.create({ data: { productId: p.id, sku: "sku-hc-0002", attributes: {} } });
    await prisma.barcode.create({ data: { code: "SKU-HC-0003", productId: p.id, isPrimary: true } });
    expect(value(await suggestProductSkuAction({ name: "Hoodie cachmir" }))).toBe("SKU-HC-0004");
    expect(value(await suggestProductSkuAction({ name: "T-shirt Basic Noir" }))).toBe("SKU-TBN-0001");
  });

  it("another tenant's SKUs neither block nor leak", async () => {
    await prismaBase.tenant.create({ data: { id: "tenant-b-sku", name: "B", slug: "tenant-b-sku" } });
    await prismaBase.product.create({ data: { tenantId: "tenant-b-sku", name: "x", sku: "SKU-HC-0001", price: 1 } });
    await loginAsTestUser({ role: "ADMIN" });
    expect(value(await suggestProductSkuAction({ name: "Hoodie cachmir" }))).toBe("SKU-HC-0001");
  });

  it("writes nothing, requires a name, and keeps the permission (products.create)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const before = await Promise.all([prismaBase.product.count(), prismaBase.auditEvent.count()]);
    await suggestProductSkuAction({ name: "Hoodie cachmir" });
    expect(await Promise.all([prismaBase.product.count(), prismaBase.auditEvent.count()])).toEqual(before);
    expect((await suggestProductSkuAction({ name: "   " })).ok).toBe(false);

    mockCookieStore.clear();
    await loginAsTestUser({ role: "WAREHOUSE" }); // products.view only
    await expect(suggestProductSkuAction({ name: "Hoodie cachmir" })).rejects.toThrow(/Non autorisé/i);
  });

  it("the generated SKU is accepted by creation, and a taken one is still refused there", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const sku = value(await suggestProductSkuAction({ name: "Hoodie cachmir" }))!;
    const fd = (s: string) => {
      const f = new FormData();
      f.set("name", "Hoodie cachmir");
      f.set("sku", s);
      f.set("price", "99");
      return f;
    };
    expect((await createProductAction(fd(sku))).ok).toBe(true);
    // Suggestion was only a suggestion: reusing it now is refused by the unchanged server check.
    expect((await createProductAction(fd(sku))).ok).toBe(false);
    expect(value(await suggestProductSkuAction({ name: "Hoodie cachmir" }))).toBe("SKU-HC-0002");
  });
});

describe("suggestProductReferenceAction", () => {
  it("REF-HC-0001, skipping references already used in this tenant (references stay non-unique)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    expect(value(await suggestProductReferenceAction({ name: "Hoodie cachmir" }))).toBe("REF-HC-0001");
    await prisma.product.create({ data: { name: "a", sku: "A-1", price: 1, reference: "REF-HC-0001" } });
    await prisma.product.create({ data: { name: "b", sku: "B-1", price: 1, reference: "REF-HC-0001" } }); // duplicates still allowed
    expect(value(await suggestProductReferenceAction({ name: "Hoodie cachmir" }))).toBe("REF-HC-0002");
  });

  it("the same product gets a matching pair when nothing is taken yet", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    expect(value(await suggestProductReferenceAction({ name: "Hoodie cachmir" }))).toBe("REF-HC-0001");
    expect(value(await suggestProductSkuAction({ name: "Hoodie cachmir" }))).toBe("SKU-HC-0001");
  });

  it("permission unchanged", async () => {
    await loginAsTestUser({ role: "CONFIRMATION" });
    await expect(suggestProductReferenceAction({ name: "Hoodie cachmir" })).rejects.toThrow(/Non autorisé/i);
  });
});
