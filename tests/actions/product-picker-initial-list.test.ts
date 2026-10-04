import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { searchProductsForOrderAction } from "@/actions/orders";
import { lookupForSaleAction } from "@/actions/sales";
import { lookupSellableUnitsAction } from "@/actions/catalog";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser, grantChannelAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Product pickers open with an initial list when the search is EMPTY
 * (online order « Ajouter un produit », store-sale field, reception field). Typed search and
 * the scanner's exact match are unchanged; the empty list keeps every rule
 * of the search: tenant, permission, active status, channel, location
 * stock, cost visibility — and is capped (never the whole catalogue).
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

const pad = (n: number) => String(n).padStart(2, "0");

describe("online order picker — searchProductsForOrderAction", () => {
  it("empty query → at most 20 ACTIVE products of this tenant, by name; inactive and other-tenant products excluded", async () => {
    for (let i = 25; i >= 1; i--) await prisma.product.create({ data: { name: `Produit ${pad(i)}`, sku: `P-${pad(i)}`, price: 10, status: "ACTIF" } });
    await prisma.product.create({ data: { name: "Aaa brouillon", sku: "DRAFT-1", price: 10, status: "BROUILLON" } });
    await prisma.product.create({ data: { name: "Aaa archivé", sku: "ARCH-1", price: 10, status: "ARCHIVE" } });
    await prismaBase.tenant.create({ data: { id: "tenant-b-picker", name: "B", slug: "tenant-b-picker" } });
    await prismaBase.product.create({ data: { tenantId: "tenant-b-picker", name: "Aaa autre tenant", sku: "B-1", price: 10, status: "ACTIF" } });
    await loginAsTestUser({ role: "ADMIN" });

    const list = await searchProductsForOrderAction("");
    expect(list).toHaveLength(20);
    expect(list.map((p) => p.name)).toEqual(Array.from({ length: 20 }, (_, i) => `Produit ${pad(i + 1)}`));
    expect(list.every((p) => p.status === "ACTIF")).toBe(true);
    expect(list.some((p) => p.tenantId !== "default")).toBe(false);
    expect(await searchProductsForOrderAction("   ")).toHaveLength(20); // whitespace = empty
  });

  it("1 character still returns nothing; 2+ characters keep the unchanged search", async () => {
    await prisma.product.create({ data: { name: "Basket Pro", sku: "BP-1", price: 10, status: "ACTIF" } });
    await prisma.product.create({ data: { name: "Casquette", sku: "CQ-1", price: 10, status: "ACTIF" } });
    await loginAsTestUser({ role: "ADMIN" });
    expect(await searchProductsForOrderAction("B")).toEqual([]);
    expect((await searchProductsForOrderAction("Basket")).map((p) => p.sku)).toEqual(["BP-1"]);
  });

  it("same serialization and cost rule on the empty list: cost only with finance.view; inactive variations dropped", async () => {
    const p = await prisma.product.create({ data: { name: "Basket", sku: "BK-1", price: 300, cost: 120, status: "ACTIF" } });
    await prisma.productVariation.create({ data: { productId: p.id, sku: "BK-1-42", attributes: { Taille: "42" }, price: 310, cost: 80 } });
    await prisma.productVariation.create({ data: { productId: p.id, sku: "BK-1-43", attributes: { Taille: "43" }, isActive: false } });

    await loginAsTestUser({ role: "CONFIRMATION" }); // orders.create, no finance.view
    const [noFinance] = await searchProductsForOrderAction("");
    expect(noFinance.price).toBe("300");
    expect(noFinance.cost).toBeNull();
    expect(noFinance.variations.map((v) => [v.sku, v.cost])).toEqual([["BK-1-42", null]]);

    mockCookieStore.clear();
    await loginAsTestUser({ role: "ADMIN" });
    const [withFinance] = await searchProductsForOrderAction("");
    expect(withFinance.cost).toBe("120");
    expect(withFinance.variations[0].cost).toBe("80");
  });

  it("permission unchanged: without orders.create the empty query is refused", async () => {
    await prisma.product.create({ data: { name: "Basket", sku: "BK-1", price: 10, status: "ACTIF" } });
    await loginAsTestUser({ role: "WAREHOUSE" });
    await expect(searchProductsForOrderAction("")).rejects.toThrow(/Non autorisé/i);
  });
});

async function seedStore() {
  const store = await prisma.warehouse.create({ data: { name: "Boutique Casa", type: "MAGASIN", isDefault: true } });
  const other = await prisma.warehouse.create({ data: { name: "Boutique Rabat", type: "MAGASIN" } });
  const channel = await prisma.salesChannel.create({ data: { name: "Magasin Casablanca", kind: "OFFLINE" } });
  await prisma.salesChannelLocation.create({ data: { salesChannelId: channel.id, warehouseId: store.id } });
  const otherChannel = await prisma.salesChannel.create({ data: { name: "Magasin Rabat", kind: "OFFLINE" } });
  await prisma.salesChannelLocation.create({ data: { salesChannelId: otherChannel.id, warehouseId: other.id } });
  return { store, other, channel, otherChannel };
}

async function sellable(ctx: { channel: { id: string }; store: { id: string } }, name: string, sku: string, opts: { onHand?: number; reserved?: number; status?: "ACTIF" | "ARCHIVE" } = {}) {
  const product = await prisma.product.create({ data: { name, sku, price: 100, cost: 40, status: opts.status ?? "ACTIF" } });
  await prisma.productSalesChannel.create({ data: { productId: product.id, salesChannelId: ctx.channel.id } });
  await prisma.inventoryItem.create({
    data: { warehouseId: ctx.store.id, productId: product.id, quantityOnHand: opts.onHand ?? 5, quantityReserved: opts.reserved ?? 0 },
  });
  return product;
}

describe("store sale picker — lookupForSaleAction", () => {
  it("empty query → at most 20 units ENABLED ON THE SELECTED CHANNEL, active only, by name, with availability at the selected location", async () => {
    const ctx = await seedStore();
    for (let i = 22; i >= 1; i--) await sellable(ctx, `Article ${pad(i)}`, `A-${pad(i)}`);
    await sellable(ctx, "Aaa archivé", "ARCH-1", { status: "ARCHIVE" });
    // Active, but on ANOTHER channel only → never listed here.
    const elsewhere = await prisma.product.create({ data: { name: "Aaa autre canal", sku: "OC-1", price: 1, status: "ACTIF" } });
    await prisma.productSalesChannel.create({ data: { productId: elsewhere.id, salesChannelId: ctx.otherChannel.id } });
    await loginAsTestUser({ role: "ADMIN" });

    const hits = await lookupForSaleAction({ query: "", salesChannelId: ctx.channel.id, warehouseId: ctx.store.id });
    expect(hits).toHaveLength(20);
    expect(hits.map((h) => h.unit.name)).toEqual(Array.from({ length: 20 }, (_, i) => `Article ${pad(i + 1)}`));
    expect(hits.every((h) => h.unit.matchedBy === "partial")).toBe(true); // never triggers the scanner auto-add
    expect(hits[0]).toMatchObject({ onHand: 5, available: 5, tracked: true });
    expect("cost" in hits[0].unit).toBe(false); // seller-safe payload, as for a search
  });

  it("availability is computed for the selected location (onHand − reserved), untracked flagged", async () => {
    const ctx = await seedStore();
    await sellable(ctx, "Basket", "BK-1", { onHand: 10, reserved: 4 });
    const noRow = await prisma.product.create({ data: { name: "Casquette", sku: "CQ-1", price: 5, status: "ACTIF" } });
    await prisma.productSalesChannel.create({ data: { productId: noRow.id, salesChannelId: ctx.channel.id } });
    await loginAsTestUser({ role: "ADMIN" });
    const hits = await lookupForSaleAction({ query: "", salesChannelId: ctx.channel.id, warehouseId: ctx.store.id });
    expect(hits.find((h) => h.unit.sku === "BK-1")).toMatchObject({ onHand: 10, available: 6, tracked: true });
    expect(hits.find((h) => h.unit.sku === "CQ-1")).toMatchObject({ available: 0, tracked: false });
  });

  it("out-of-scope channel/location: still refused or empty — no unauthorized data", async () => {
    const ctx = await seedStore();
    await sellable(ctx, "Basket", "BK-1");
    // Location not linked to the channel → nothing.
    await loginAsTestUser({ role: "ADMIN" });
    expect(await lookupForSaleAction({ query: "", salesChannelId: ctx.channel.id, warehouseId: ctx.other.id })).toEqual([]);
    // Channel granted but no location access → refused, exactly like a typed search.
    mockCookieStore.clear();
    const u = await loginAsTestUser({ role: "MANAGER", channels: "none" });
    await grantChannelAccess(u.id, ctx.channel.id);
    await expect(lookupForSaleAction({ query: "", salesChannelId: ctx.channel.id, warehouseId: ctx.store.id })).rejects.toThrow(/non autorisé/i);
  });

  it("typed search and exact barcode/SKU behave as before", async () => {
    const ctx = await seedStore();
    const p = await sellable(ctx, "Basket", "BK-1");
    await sellable(ctx, "Basket rouge", "BK-2");
    await prisma.barcode.create({ data: { code: "6111111111142", productId: p.id, isPrimary: true } });
    await loginAsTestUser({ role: "ADMIN" });
    const sku = await lookupForSaleAction({ query: "BK-1", salesChannelId: ctx.channel.id, warehouseId: ctx.store.id });
    expect(sku.map((h) => [h.unit.sku, h.unit.matchedBy])).toEqual([["BK-1", "sku"]]);
    const barcode = await lookupForSaleAction({ query: "6111111111142", salesChannelId: ctx.channel.id, warehouseId: ctx.store.id });
    expect(barcode.map((h) => [h.unit.sku, h.unit.matchedBy])).toEqual([["BK-1", "barcode"]]);
    const partial = await lookupForSaleAction({ query: "Basket", salesChannelId: ctx.channel.id, warehouseId: ctx.store.id });
    expect(partial.map((h) => h.unit.sku).sort()).toEqual(["BK-1", "BK-2"]);
  });
});

describe("reception picker — lookupSellableUnitsAction", () => {
  it("empty query → at most 20 ACTIVE units of this tenant by name; archived and other-tenant excluded; tagged partial", async () => {
    for (let i = 23; i >= 1; i--) await prisma.product.create({ data: { name: `Article ${pad(i)}`, sku: `R-${pad(i)}`, price: 10, cost: 4, status: "ACTIF" } });
    await prisma.product.create({ data: { name: "Aaa archivé", sku: "ARCH-1", price: 10, status: "ARCHIVE" } });
    await prismaBase.tenant.create({ data: { id: "tenant-b-recpick", name: "B", slug: "tenant-b-recpick" } });
    await prismaBase.product.create({ data: { tenantId: "tenant-b-recpick", name: "Aaa autre tenant", sku: "B-1", price: 10, status: "ACTIF" } });
    await loginAsTestUser({ role: "ADMIN" });

    const list = await lookupSellableUnitsAction({ query: "" });
    expect(list).toHaveLength(20);
    expect(list.map((u) => u.name)).toEqual(Array.from({ length: 20 }, (_, i) => `Article ${pad(i + 1)}`));
    expect(list.every((u) => u.matchedBy === "partial")).toBe(true); // never triggers the scanner auto-add
    expect(list.some((u) => u.sku === "ARCH-1" || u.sku === "B-1")).toBe(false);
    // Archived products stay reachable by typing, exactly as before.
    expect((await lookupSellableUnitsAction({ query: "ARCH-1" })).map((u) => [u.sku, u.matchedBy])).toEqual([["ARCH-1", "sku"]]);
  });

  it("cost rule unchanged: cost only with finance.view", async () => {
    await prisma.product.create({ data: { name: "Basket", sku: "BK-1", price: 300, cost: 120, status: "ACTIF" } });
    await loginAsTestUser({ role: "WAREHOUSE" }); // products.view, no finance.view
    expect((await lookupSellableUnitsAction({ query: "" }))[0].cost).toBeNull();
    mockCookieStore.clear();
    await loginAsTestUser({ role: "ADMIN" });
    expect((await lookupSellableUnitsAction({ query: "" }))[0].cost).toBe(120);
  });

  it("permission and capability unchanged: refused without products.view, or in an ONLINE_ONLY tenant", async () => {
    await prisma.product.create({ data: { name: "Basket", sku: "BK-1", price: 10, status: "ACTIF" } });
    await loginAsTestUser({ role: "STORE_SELLER" }); // no products.view
    await expect(lookupSellableUnitsAction({ query: "" })).rejects.toThrow(/Non autorisé/i);
    mockCookieStore.clear();
    await setTestBusinessMode("ONLINE_ONLY");
    await loginAsTestUser({ role: "ADMIN" });
    await expect(lookupSellableUnitsAction({ query: "" })).rejects.toThrow(/Non autorisé/i);
  });
});
