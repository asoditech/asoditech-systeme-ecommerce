import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { resolveExactCode, EXACT_CODE_MESSAGES } from "@/lib/catalog/exact-code";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/** Shared exact barcode / SKU resolution (src/lib/catalog/exact-code.ts) — used by packing, next by returns. */

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  await loginAsTestUser({ role: "MANAGER" });
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

async function seed() {
  const tshirt = await prisma.product.create({ data: { name: "T-shirt", sku: "TS-PARENT", price: 100, status: "ACTIF" } });
  const noir = await prisma.productVariation.create({ data: { productId: tshirt.id, sku: "TS-NOIR", attributes: { Couleur: "Noir" }, price: 100 } });
  const blanc = await prisma.productVariation.create({ data: { productId: tshirt.id, sku: "TS-BLANC", attributes: { Couleur: "Blanc" }, price: 100, isActive: false } });
  await prisma.barcode.create({ data: { code: "6111111111111", variationId: noir.id, isPrimary: true } });
  const cap = await prisma.product.create({ data: { name: "Casquette", sku: "CAP-1", price: 50, status: "ARCHIVE" } });
  await prisma.barcode.create({ data: { code: "6222222222222", productId: tshirt.id } }); // product-level code on a variable product
  return { tshirt, noir, blanc, cap };
}

describe("resolveExactCode", () => {
  it("exact barcode → the one variation", async () => {
    const { noir } = await seed();
    const r = await resolveExactCode(prisma, "6111111111111");
    expect(r.ok && r.unit.variationId).toBe(noir.id);
    expect(r.ok && r.unit.matchedBy).toBe("barcode");
  });

  it("exact variation SKU (case-insensitive, trimmed) → that variation, even when inactive", async () => {
    const { noir, blanc } = await seed();
    const r1 = await resolveExactCode(prisma, "  ts-noir ");
    expect(r1.ok && r1.unit.variationId).toBe(noir.id);
    const r2 = await resolveExactCode(prisma, "TS-BLANC");
    expect(r2.ok && r2.unit.variationId).toBe(blanc.id);
  });

  it("exact simple-product SKU → that product, even when archived", async () => {
    const { cap } = await seed();
    const r = await resolveExactCode(prisma, "CAP-1");
    expect(r.ok && r.unit).toMatchObject({ productId: cap.id, variationId: null, matchedBy: "sku" });
  });

  it("a code standing for several units is ambiguous (parent SKU, product-level barcode of a variable product)", async () => {
    await seed();
    expect(await resolveExactCode(prisma, "TS-PARENT")).toEqual({ ok: false, reason: "ambiguous", error: EXACT_CODE_MESSAGES.ambiguous });
    expect(await resolveExactCode(prisma, "6222222222222")).toMatchObject({ ok: false, reason: "ambiguous" });
  });

  it("no fuzzy matching: name, partial SKU, unknown or empty code → not found", async () => {
    await seed();
    for (const code of ["T-shirt", "Casquette", "TS-NO", "CAP", "UNKNOWN", "", "   "]) {
      expect(await resolveExactCode(prisma, code), code).toEqual({ ok: false, reason: "not_found", error: EXACT_CODE_MESSAGES.notFound });
    }
  });
});
