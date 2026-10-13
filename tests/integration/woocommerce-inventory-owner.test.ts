import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import { setWooCommerceInventoryOwnerAction, syncWooCommerceProductsAction } from "@/actions/woocommerce";
import { inventoryOwnerOf } from "@/lib/integrations/woocommerce/store-settings";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import {
  FAKE_CONSUMER_KEY,
  FAKE_CONSUMER_SECRET,
  FAKE_STORE_URL,
  emptyFakeStore,
  installFakeWooCommerceServer,
  type FakeProduct,
  type FakeStoreState,
} from "../helpers/fake-woocommerce";

/**
 * « Qui gère le stock des produits importés ? » (store-settings.ts):
 * ASODITECH by default (docs/adr/0036) — an imported unit the store manages
 * gets ONE row, at the quantity the store reports (none when it reports none
 * — never an invented 0), never overwritten afterwards; the store → no row
 * created by the import. Switching never touches existing stock.
 */

let state: FakeStoreState;
let warehouseId: string;

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  state = emptyFakeStore();
  installFakeWooCommerceServer(state);
  warehouseId = (await prisma.warehouse.create({ data: { name: "Entrepôt principal", isDefault: true } })).id;
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  vi.unstubAllGlobals();
});

async function seedIntegration(config: Record<string, unknown> = {}) {
  return prisma.integration.create({
    data: {
      provider: "WOOCOMMERCE",
      status: "CONNECTE",
      config: { siteUrl: FAKE_STORE_URL, ...config },
      credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: FAKE_CONSUMER_KEY, apiSecret: FAKE_CONSUMER_SECRET })),
    },
  });
}

const simple = (id: number, sku: string, manage: boolean, qty: number | null): FakeProduct => ({
  id,
  name: `Produit ${sku}`,
  slug: sku.toLowerCase(),
  sku,
  status: "publish",
  type: "simple",
  regular_price: "100",
  manage_stock: manage,
  stock_quantity: qty,
  categories: [],
});

/** Tracked with a quantity, tracked without one, untracked; and a variable product with the same three variation cases. */
function catalog(): FakeProduct[] {
  return [
    simple(101, "AVEC-QTE", true, 5),
    simple(102, "SANS-QTE", true, null),
    simple(103, "NON-SUIVI", false, null),
    {
      ...simple(104, "VAR", false, null),
      type: "variable",
      variations: [1041, 1042, 1043],
      variationList: [
        { id: 1041, sku: "VAR-S", regular_price: "100", manage_stock: true, stock_quantity: 3, attributes: [{ name: "Taille", option: "S" }] },
        { id: 1042, sku: "VAR-M", regular_price: "100", manage_stock: true, stock_quantity: null, attributes: [{ name: "Taille", option: "M" }] },
        { id: 1043, sku: "VAR-L", regular_price: "100", manage_stock: false, stock_quantity: null, attributes: [{ name: "Taille", option: "L" }] },
      ],
    },
  ];
}

async function sync() {
  const res = await syncWooCommerceProductsAction();
  expect(res.ok).toBe(true);
}

/** sku → quantityOnHand of its row(s) in the default warehouse. */
async function rows(): Promise<Record<string, number[]>> {
  const items = await prisma.inventoryItem.findMany({ include: { product: { select: { sku: true } }, variation: { select: { sku: true } } } });
  const out: Record<string, number[]> = {};
  for (const i of items) {
    const sku = i.variation?.sku ?? i.product?.sku ?? "?";
    (out[sku] ??= []).push(i.quantityOnHand);
  }
  return out;
}

describe("ASODITECH manages the stock (default)", () => {
  it.each([
    ["missing setting", {}],
    ["invalid setting", { inventoryOwner: "BOTH" }],
    ["explicit ASODITECH", { inventoryOwner: "ASODITECH" }],
  ])("%s: each tracked unit with a store quantity gets one row at it; no quantity / untracked → none; no movement invented", async (_, config) => {
    await seedIntegration(config);
    await loginAsTestUser({ role: "ADMIN" });
    state.products = catalog();
    await sync();

    expect(await rows()).toEqual({ "AVEC-QTE": [5], "VAR-S": [3] });
    expect(await prisma.inventoryMovement.count()).toBe(0);
    expect(await prisma.product.count({ where: { source: "WOOCOMMERCE" } })).toBe(4);
  });

  it("re-import never resets a quantity, never duplicates a row, never touches movements", async () => {
    await seedIntegration();
    await loginAsTestUser({ role: "ADMIN" });
    state.products = catalog();
    await sync();

    // ASODITECH's own stock moves on (sale, reception…) while the store's number changes too.
    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { product: { sku: "AVEC-QTE" } } });
    await prisma.inventoryItem.update({ where: { id: item.id }, data: { quantityOnHand: 12 } });
    await prisma.inventoryMovement.create({ data: { inventoryItemId: item.id, warehouseId, type: "RECEPTION", quantity: 7 } });
    state.products[0].stock_quantity = 40;
    state.products[1].stock_quantity = 40; // the store now reports a quantity: the missing row is onboarded at it

    await sync();
    await sync();

    expect(await rows()).toEqual({ "AVEC-QTE": [12], "SANS-QTE": [40], "VAR-S": [3] });
    expect(await prisma.inventoryMovement.count()).toBe(1);
  });
});

describe("the online store manages the stock", () => {
  it("import creates no ASODITECH stock row (no reservation / push basis), products still imported and linked", async () => {
    await seedIntegration({ inventoryOwner: "STORE" });
    await loginAsTestUser({ role: "ADMIN" });
    state.products = catalog();
    await sync();

    expect(await prisma.inventoryItem.count()).toBe(0);
    expect(await prisma.inventoryMovement.count()).toBe(0);
    const imported = await prisma.product.findMany({ where: { source: "WOOCOMMERCE" }, select: { sku: true, externalId: true, trackInventory: true } });
    expect(imported).toHaveLength(4);
    expect(imported.find((p) => p.sku === "AVEC-QTE")).toMatchObject({ externalId: "101", trackInventory: true }); // store's own flag kept, nothing invented
    expect(await prisma.productVariation.count({ where: { source: "WOOCOMMERCE" } })).toBe(3);
  });

  it("switching to the store later leaves every existing row, quantity and movement exactly as is; only new imports get none", async () => {
    const integration = await seedIntegration();
    await loginAsTestUser({ role: "ADMIN" });
    state.products = catalog();
    await sync();
    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { product: { sku: "AVEC-QTE" } } });
    await prisma.inventoryMovement.create({ data: { inventoryItemId: item.id, warehouseId, type: "RECEPTION", quantity: 5 } });
    const before = await prisma.inventoryItem.findMany({ orderBy: { id: "asc" } });

    expect(await setWooCommerceInventoryOwnerAction("STORE")).toEqual({ ok: true, data: { owner: "STORE" } });
    expect(await prisma.inventoryItem.findMany({ orderBy: { id: "asc" } })).toEqual(before); // the switch itself writes no stock

    state.products.push(simple(105, "NOUVEAU", true, 8));
    await sync();
    expect(await prisma.inventoryItem.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    expect(await prisma.inventoryMovement.count()).toBe(1);
    expect(await prisma.product.findFirst({ where: { sku: "NOUVEAU" } })).not.toBeNull();
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: integration.id, action: "integration.updated" } });
    expect(audit.metadata).toMatchObject({ change: "inventory_owner", previous: "ASODITECH", owner: "STORE", linkedStockRows: 2 });
  });
});

describe("setting: per company, validated, protected", () => {
  it("fallback is ASODITECH for anything but an explicit STORE", () => {
    expect(inventoryOwnerOf(undefined)).toBe("ASODITECH");
    expect(inventoryOwnerOf({ inventoryOwner: "store" })).toBe("ASODITECH");
    expect(inventoryOwnerOf({ inventoryOwner: "STORE" })).toBe("STORE");
  });

  it("is stored on this company's connection only; invalid values and unauthorised users are refused", async () => {
    const TENANT_B = "tenant-b-inventory-owner";
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "B", slug: TENANT_B } });
    const b = await prismaBase.integration.create({ data: { tenantId: TENANT_B, provider: "WOOCOMMERCE", status: "CONNECTE", config: { siteUrl: "https://b.example.com" } } });
    const a = await seedIntegration();

    await loginAsTestUser({ role: "MANAGER" });
    await expect(setWooCommerceInventoryOwnerAction("STORE")).rejects.toThrow(/autoris/i);

    await loginAsTestUser({ role: "ADMIN" });
    expect(await setWooCommerceInventoryOwnerAction("LES_DEUX")).toMatchObject({ ok: false, error: "Choix invalide." });
    expect(await setWooCommerceInventoryOwnerAction("STORE")).toMatchObject({ ok: true });

    expect(inventoryOwnerOf((await prismaBase.integration.findUniqueOrThrow({ where: { id: a.id } })).config)).toBe("STORE");
    expect(inventoryOwnerOf((await prismaBase.integration.findUniqueOrThrow({ where: { id: b.id } })).config)).toBe("ASODITECH");
    // the other setting is not inferred from this one
    expect(((await prismaBase.integration.findUniqueOrThrow({ where: { id: a.id } })).config as Record<string, unknown>).remoteDeletionMode).toBeUndefined();
  });
});
