import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { lookupForSaleAction } from "@/actions/sales";
import { lookupSellableUnitsAction } from "@/actions/catalog";
import { searchProductsForOrderAction } from "@/actions/orders";
import { quickSearchAction } from "@/actions/search";
import { findTraceUnits } from "@/lib/queries/traceability";
import { listProducts } from "@/lib/queries/products";
import { variationIdsMatchingOptionValue } from "@/lib/catalog/variation-search";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Product search also matches variation OPTION VALUES ("Rouge", "XL") in
 * every shared search: sales, receptions, traceability, orders, palette and
 * the product list. Values only (never keys); tenant-scoped; exact barcode /
 * SKU (scanner) behaviour unchanged.
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

async function world() {
  const shop = await prisma.warehouse.create({ data: { name: "Boutique", type: "MAGASIN", isDefault: true } });
  const channel = await prisma.salesChannel.create({ data: { name: "Magasin", kind: "OFFLINE" } });
  await prisma.salesChannelLocation.create({ data: { salesChannelId: channel.id, warehouseId: shop.id } });
  const tshirt = await prisma.product.create({ data: { name: "T-Shirt", sku: "TS", price: 99, status: "ACTIF" } });
  await prisma.productSalesChannel.create({ data: { productId: tshirt.id, salesChannelId: channel.id } });
  const combos: [string, string][] = [["Rouge", "M"], ["Rouge", "L"], ["Noir", "M"], ["Bleu", "XL"]];
  const v: Record<string, string> = {};
  for (const [c, t] of combos) {
    const row = await prisma.productVariation.create({ data: { productId: tshirt.id, sku: `TS-${c}-${t}`.toUpperCase(), attributes: { Couleur: c, Taille: t } } });
    v[`${c}/${t}`] = row.id;
    await prisma.inventoryItem.create({ data: { warehouseId: shop.id, variationId: row.id, quantityOnHand: 3 } });
  }
  // A product whose NAME contains « rouge » keeps the pre-existing behaviour.
  const rougeName = await prisma.product.create({ data: { name: "Casquette rouge", sku: "CQ-1", price: 50, status: "ACTIF" } });
  await prisma.productSalesChannel.create({ data: { productId: rougeName.id, salesChannelId: channel.id } });
  return { shop, channel, tshirt, v };
}

const skus = (units: { sku: string }[]) => units.map((u) => u.sku).sort();

describe("option-value search in every shared search", () => {
  it("sales: « Rouge » → the two red T-shirt units (+ the product named rouge); « XL » → the blue XL", async () => {
    const w = await world();
    await loginAsTestUser({ role: "ADMIN" });
    const rouge = await lookupForSaleAction({ query: "Rouge", salesChannelId: w.channel.id, warehouseId: w.shop.id });
    expect(skus(rouge.map((h) => h.unit))).toEqual(["CQ-1", "TS-ROUGE-L", "TS-ROUGE-M"]);
    expect(rouge.filter((h) => h.unit.variationId).every((h) => /Rouge/.test(h.unit.variantLabel ?? ""))).toBe(true); // shows WHY it matched
    const xl = await lookupForSaleAction({ query: "xl", salesChannelId: w.channel.id, warehouseId: w.shop.id });
    expect(skus(xl.map((h) => h.unit))).toEqual(["TS-BLEU-XL"]);
    // Label = the existing variantLabel (jsonb key order) — it carries both values.
    expect(xl[0].unit.variantLabel?.split(" / ").sort()).toEqual(["Bleu", "XL"]);
  });

  it("receptions and traceability use the same lookup", async () => {
    await world();
    await loginAsTestUser({ role: "ADMIN" });
    expect(skus(await lookupSellableUnitsAction({ query: "rouge" }))).toEqual(["CQ-1", "TS-ROUGE-L", "TS-ROUGE-M"]);
    expect(skus(await findTraceUnits("Bleu"))).toEqual(["TS-BLEU-XL"]);
  });

  it("orders picker: the T-shirt is offered with ONLY its matching variations", async () => {
    await world();
    await loginAsTestUser({ role: "ADMIN" });
    const res = await searchProductsForOrderAction("Rouge");
    const tshirt = res.find((p) => p.sku === "TS")!;
    expect(tshirt.variations.map((v) => v.sku).sort()).toEqual(["TS-ROUGE-L", "TS-ROUGE-M"]);
    const named = res.find((p) => p.sku === "CQ-1")!;
    expect(named).toBeDefined();
    // Name match → all variations, as before.
    const byName = (await searchProductsForOrderAction("T-Shirt")).find((p) => p.sku === "TS")!;
    expect(byName.variations).toHaveLength(4);
  });

  it("command palette and product list find it too; the palette says which variations matched", async () => {
    await world();
    await loginAsTestUser({ role: "ADMIN" });
    const hits = (await quickSearchAction("XL")).filter((r) => r.type === "product");
    expect(hits.map((r) => r.title)).toEqual(["T-Shirt"]);
    expect(hits[0].subtitle).toMatch(/Bleu/);
    expect(hits[0].subtitle).toMatch(/XL/);
    const list = await listProducts({ q: "noir" });
    expect(list.products.map((p) => p.sku)).toEqual(["TS"]);
  });

  it("option KEYS are not searched; LIKE wildcards are literal", async () => {
    await world();
    await loginAsTestUser({ role: "ADMIN" });
    expect(await variationIdsMatchingOptionValue("Couleur")).toEqual([]);
    expect(await variationIdsMatchingOptionValue("Taille")).toEqual([]);
    expect(await variationIdsMatchingOptionValue("%")).toEqual([]);
    expect(await variationIdsMatchingOptionValue("_")).toEqual([]);
    expect(await variationIdsMatchingOptionValue("   ")).toEqual([]);
  });
});

describe("tenant isolation", () => {
  it("another company's « Rouge » variations are never returned", async () => {
    const w = await world();
    await prismaBase.tenant.create({ data: { id: "tenant-b-varsearch", name: "B", slug: "tenant-b-varsearch" } });
    const pB = await prismaBase.product.create({ data: { tenantId: "tenant-b-varsearch", name: "Pull B", sku: "PB", price: 1, status: "ACTIF" } });
    const vB = await prismaBase.productVariation.create({
      data: { tenantId: "tenant-b-varsearch", productId: pB.id, sku: "PB-ROUGE", attributes: { Couleur: "Rouge" } },
    });
    await loginAsTestUser({ role: "ADMIN" });
    const ids = await variationIdsMatchingOptionValue("Rouge");
    expect(ids).not.toContain(vB.id);
    expect(ids.sort()).toEqual([w.v["Rouge/L"], w.v["Rouge/M"]].sort());
    expect(skus(await lookupSellableUnitsAction({ query: "Rouge" }))).not.toContain("PB-ROUGE");
    expect((await searchProductsForOrderAction("Rouge")).map((p) => p.sku)).not.toContain("PB");
  });
});

describe("existing search behaviour unchanged", () => {
  it("exact variation SKU and barcode still resolve to exactly that unit (scanner)", async () => {
    const w = await world();
    await prisma.barcode.create({ data: { code: "6111111111999", variationId: w.v["Noir/M"], isPrimary: true } });
    await loginAsTestUser({ role: "ADMIN" });
    const sku = await lookupForSaleAction({ query: "TS-ROUGE-M", salesChannelId: w.channel.id, warehouseId: w.shop.id });
    expect(sku.map((h) => [h.unit.sku, h.unit.matchedBy])).toEqual([["TS-ROUGE-M", "sku"]]);
    const bc = await lookupForSaleAction({ query: "6111111111999", salesChannelId: w.channel.id, warehouseId: w.shop.id });
    expect(bc.map((h) => [h.unit.sku, h.unit.matchedBy])).toEqual([["TS-NOIR-M", "barcode"]]);
  });

  it("product name / partial variation SKU searches still return every unit of the product", async () => {
    await world();
    await loginAsTestUser({ role: "ADMIN" });
    expect(skus(await lookupSellableUnitsAction({ query: "T-Shirt" }))).toEqual(["TS-BLEU-XL", "TS-NOIR-M", "TS-ROUGE-L", "TS-ROUGE-M"]);
    expect(skus(await lookupSellableUnitsAction({ query: "TS-"}))).toEqual(["TS-BLEU-XL", "TS-NOIR-M", "TS-ROUGE-L", "TS-ROUGE-M"]);
  });
});
