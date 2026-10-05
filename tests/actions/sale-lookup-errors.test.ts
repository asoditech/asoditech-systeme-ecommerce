import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { lookupForSaleAction, searchForSaleAction } from "@/actions/sales";
import { classifySaleLookupError, SALE_LOOKUP_MESSAGES } from "@/lib/sales/lookup-errors";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser, grantChannelAccess, grantLocationAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Store-sale search failures are SHOWN, never crash the page (reported by an
 * existing store seller). Authorization is unchanged: `lookupForSaleAction`
 * still refuses exactly as before; `searchForSaleAction` only reports why.
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

async function store() {
  const shop = await prisma.warehouse.create({ data: { name: "Boutique", type: "MAGASIN", isDefault: true } });
  const other = await prisma.warehouse.create({ data: { name: "Dépôt", type: "MAGASIN" } });
  const channel = await prisma.salesChannel.create({ data: { name: "Magasin", kind: "OFFLINE" } });
  await prisma.salesChannelLocation.create({ data: { salesChannelId: channel.id, warehouseId: shop.id } });
  const p = await prisma.product.create({ data: { name: "Basket", sku: "BK-1", price: 300, status: "ACTIF" } });
  await prisma.productSalesChannel.create({ data: { productId: p.id, salesChannelId: channel.id } });
  await prisma.inventoryItem.create({ data: { warehouseId: shop.id, productId: p.id, quantityOnHand: 5 } });
  return { shop, other, channel };
}

describe("classifySaleLookupError", () => {
  it("maps each server guard message to a readable failure", () => {
    expect(classifySaleLookupError(new Error("Non autorisé : session invalide ou expirée."))).toBe("session");
    expect(classifySaleLookupError(new Error("Non autorisé : accès à cet emplacement non attribué."))).toBe("location");
    expect(classifySaleLookupError(new Error("Non autorisé : ce canal ne vous est pas attribué."))).toBe("channel");
    expect(classifySaleLookupError(new Error("Non autorisé : accès au canal requis pour cette action."))).toBe("channel");
    expect(classifySaleLookupError(new Error("Non autorisé : permission manquante pour cette action."))).toBe("permission");
    expect(classifySaleLookupError(new Error("boom"))).toBeNull();
    expect(classifySaleLookupError("x")).toBeNull();
  });
});

describe("searchForSaleAction — same checks, failure reported instead of thrown", () => {
  it("a correctly configured store seller gets results (typed search and the empty-query list)", async () => {
    const w = await store();
    const u = await loginAsTestUser({ role: "STORE_SELLER", channels: "none" });
    await grantChannelAccess(u.id, w.channel.id);
    await grantLocationAccess(u.id, w.shop.id);
    const typed = await searchForSaleAction({ query: "Basket", salesChannelId: w.channel.id, warehouseId: w.shop.id });
    const list = await searchForSaleAction({ query: "", salesChannelId: w.channel.id, warehouseId: w.shop.id });
    expect(typed.ok && typed.data.map((h) => h.unit.sku)).toEqual(["BK-1"]);
    expect(list.ok && list.data.map((h) => h.unit.sku)).toEqual(["BK-1"]);
  });

  it("missing location assignment → explicit « emplacement » message (the raw action still refuses, unchanged)", async () => {
    const w = await store();
    const u = await loginAsTestUser({ role: "STORE_SELLER", channels: "none" });
    await grantChannelAccess(u.id, w.channel.id); // no location access
    const input = { query: "", salesChannelId: w.channel.id, warehouseId: w.shop.id };
    await expect(lookupForSaleAction(input)).rejects.toThrow(/Non autorisé/); // authorization unchanged
    const r = await searchForSaleAction(input);
    expect(r).toEqual({ ok: false, error: SALE_LOOKUP_MESSAGES.location });
  });

  it("channel not assigned → explicit « canal » message", async () => {
    const w = await store();
    const other = await prisma.salesChannel.create({ data: { name: "Autre magasin", kind: "OFFLINE" } });
    const u = await loginAsTestUser({ role: "STORE_SELLER", channels: "none" });
    await grantChannelAccess(u.id, other.id);
    await grantLocationAccess(u.id, w.shop.id);
    const r = await searchForSaleAction({ query: "Basket", salesChannelId: w.channel.id, warehouseId: w.shop.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(SALE_LOOKUP_MESSAGES.channel);
  });

  it("no sales permission → explicit « droit de vendre » message; no session → « session expirée »", async () => {
    const w = await store();
    await loginAsTestUser({ role: "CONFIRMATION" });
    const r = await searchForSaleAction({ query: "Basket", salesChannelId: w.channel.id, warehouseId: w.shop.id });
    expect(r).toEqual({ ok: false, error: SALE_LOOKUP_MESSAGES.permission });
    mockCookieStore.clear();
    const s = await searchForSaleAction({ query: "Basket", salesChannelId: w.channel.id, warehouseId: w.shop.id });
    expect(s).toEqual({ ok: false, error: SALE_LOOKUP_MESSAGES.session });
  });

  it("business problems keep their existing behaviour (empty result, no error)", async () => {
    const w = await store();
    const u = await loginAsTestUser({ role: "STORE_SELLER", channels: "none" });
    await grantChannelAccess(u.id, w.channel.id);
    await grantLocationAccess(u.id, w.other.id);
    // Location not linked to the channel → [] as before (not an authorization error).
    expect(await searchForSaleAction({ query: "Basket", salesChannelId: w.channel.id, warehouseId: w.other.id })).toEqual({ ok: true, data: [] });
  });
});

describe("sale form uses the guarded lookup", () => {
  it("both lookups go through searchForSaleAction, and a thrown call shows the reload message", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "src/components/sales/sale-form.tsx"), "utf8");
    expect(src).not.toMatch(/await lookupForSaleAction\(/);
    expect(src.match(/await runLookup\(/g)).toHaveLength(2);
    expect(src).toContain("searchForSaleAction({ query: q, salesChannelId: channelId, warehouseId })");
    expect(src).toContain("SALE_LOOKUP_MESSAGES.stale");
    expect(src).toContain("window.location.reload()");
  });
});
