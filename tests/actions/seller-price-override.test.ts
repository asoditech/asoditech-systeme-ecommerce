import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createSaleAction } from "@/actions/sales";
import { updateSellerPriceOverrideAction } from "@/actions/settings";
import { computeEffectiveAccess } from "@/lib/auth/effective-access";
import { getCurrentUser } from "@/lib/auth/session";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser, grantChannelAccess, grantLocationAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * « Autoriser les vendeurs magasin à modifier le prix » (company setting):
 * grants `sales.override_price` through EFFECTIVE access to users who may
 * sell in store; a per-user DENY wins; the server check in createSaleAction
 * stays the final authority.
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

const OFFLINE = [{ id: "c1", kind: "OFFLINE" as const, isActive: true }];
const access = (o: Partial<Parameters<typeof computeEffectiveAccess>[0]>) =>
  computeEffectiveAccess({ role: "STORE_SELLER", overrides: [], assignedChannels: OFFLINE, businessMode: "ONLINE_AND_OFFLINE", ...o }).permissions;

describe("effective access rule", () => {
  it("OFF (default): a store seller has no price override", () => {
    expect(access({}).has("sales.override_price")).toBe(false);
    expect(access({ sellerPriceOverride: false }).has("sales.override_price")).toBe(false);
  });
  it("ON: a user who may sell in store gets it", () => {
    expect(access({ sellerPriceOverride: true }).has("sales.override_price")).toBe(true);
  });
  it("ON but explicit per-user DENY → still denied", () => {
    expect(access({ sellerPriceOverride: true, overrides: [{ permission: "sales.override_price", effect: "DENY" }] }).has("sales.override_price")).toBe(false);
  });
  it("ON never reaches a user who cannot sell in store (no sales.create, no offline channel, or Online-only company)", () => {
    expect(access({ sellerPriceOverride: true, overrides: [{ permission: "sales.create", effect: "DENY" }] }).has("sales.override_price")).toBe(false);
    expect(access({ sellerPriceOverride: true, assignedChannels: [] }).has("sales.override_price")).toBe(false);
    expect(access({ sellerPriceOverride: true, businessMode: "ONLINE_ONLY" }).has("sales.override_price")).toBe(false);
    expect(computeEffectiveAccess({ role: "CONFIRMATION", overrides: [], assignedChannels: OFFLINE, businessMode: "ONLINE_AND_OFFLINE", sellerPriceOverride: true }).permissions.has("sales.override_price")).toBe(false);
  });
  it("managers/admins keep it whatever the setting", () => {
    const m = computeEffectiveAccess({ role: "MANAGER", overrides: [], assignedChannels: OFFLINE, businessMode: "ONLINE_AND_OFFLINE", sellerPriceOverride: false });
    expect(m.permissions.has("sales.override_price")).toBe(true);
    const a = computeEffectiveAccess({ role: "ADMIN", overrides: [], assignedChannels: [], businessMode: "ONLINE_AND_OFFLINE", sellerPriceOverride: false });
    expect(a.permissions.has("sales.override_price")).toBe(true);
  });
});

async function store() {
  const shop = await prisma.warehouse.create({ data: { name: "Boutique", type: "MAGASIN", isDefault: true } });
  const channel = await prisma.salesChannel.create({ data: { name: "Magasin", kind: "OFFLINE" } });
  await prisma.salesChannelLocation.create({ data: { salesChannelId: channel.id, warehouseId: shop.id } });
  const product = await prisma.product.create({ data: { name: "Basket", sku: "BK-1", price: 300, status: "ACTIF" } });
  await prisma.productSalesChannel.create({ data: { productId: product.id, salesChannelId: channel.id } });
  await prisma.inventoryItem.create({ data: { warehouseId: shop.id, productId: product.id, quantityOnHand: 10 } });
  return { shop, channel, product };
}

const cheaperSale = (w: Awaited<ReturnType<typeof store>>) => ({
  salesChannelId: w.channel.id,
  warehouseId: w.shop.id,
  idempotencyKey: randomUUID(),
  lines: [{ productId: w.product.id, quantity: 1, unitPrice: 250 }],
  payments: [{ method: "ESPECES" as const, amount: 250 }],
});

async function setToggle(on: boolean) {
  mockCookieStore.clear();
  await loginAsTestUser({ role: "ADMIN" });
  const fd = new FormData();
  fd.set("allowSellerPriceOverride", on ? "true" : "false");
  const r = await updateSellerPriceOverrideAction(fd);
  expect(r.ok).toBe(true);
}

async function asSeller(w: Awaited<ReturnType<typeof store>>, deny = false) {
  mockCookieStore.clear();
  const u = await loginAsTestUser({ role: "STORE_SELLER", channels: "none" });
  await grantChannelAccess(u.id, w.channel.id);
  await grantLocationAccess(u.id, w.shop.id);
  if (deny) await prisma.userPermissionOverride.create({ data: { userId: u.id, permission: "sales.override_price", effect: "DENY" } });
  return u;
}

describe("enforced on the server (createSaleAction)", () => {
  it("OFF: a seller without the permission cannot sell below the catalogue price — even by editing the request", async () => {
    const w = await store();
    await asSeller(w);
    expect((await getCurrentUser())!.permissions.has("sales.override_price")).toBe(false);
    const r = await createSaleAction(cheaperSale(w));
    expect(r.ok).toBe(false);
    expect(await prisma.sale.count()).toBe(0);
  });

  it("ON: the same seller now has the effective permission and the price change is accepted", async () => {
    const w = await store();
    await setToggle(true);
    await asSeller(w);
    expect((await getCurrentUser())!.permissions.has("sales.override_price")).toBe(true);
    const r = await createSaleAction(cheaperSale(w));
    expect(r.ok).toBe(true);
    const sale = await prisma.sale.findFirstOrThrow({ include: { lines: true } });
    expect(Number(sale.lines[0].unitPrice)).toBe(250);
  });

  it("ON + explicit DENY for this seller → still rejected", async () => {
    const w = await store();
    await setToggle(true);
    await asSeller(w, true);
    expect((await getCurrentUser())!.permissions.has("sales.override_price")).toBe(false);
    expect((await createSaleAction(cheaperSale(w))).ok).toBe(false);
  });

  it("switching it back OFF removes it again", async () => {
    const w = await store();
    await setToggle(true);
    await setToggle(false);
    await asSeller(w);
    expect((await createSaleAction(cheaperSale(w))).ok).toBe(false);
  });
});

describe("the setting itself", () => {
  it("defaults to OFF for existing companies (migration default)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const s = await prisma.businessSettings.upsert({ where: { tenantId: "default" }, update: {}, create: {} });
    expect(s.allowSellerPriceOverride).toBe(false);
  });
  it("only settings.manage may change it, and only in an Online + Offline company", async () => {
    await loginAsTestUser({ role: "MANAGER" }); // no settings.manage
    const fd = new FormData();
    fd.set("allowSellerPriceOverride", "true");
    await expect(updateSellerPriceOverrideAction(fd)).rejects.toThrow(/Non autorisé/);
    mockCookieStore.clear();
    await setTestBusinessMode("ONLINE_ONLY");
    await loginAsTestUser({ role: "ADMIN" });
    await expect(updateSellerPriceOverrideAction(fd)).rejects.toThrow(/Non autorisé/);
  });
});
