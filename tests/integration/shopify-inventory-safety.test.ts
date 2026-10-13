import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { connectIntegrationAction } from "@/actions/integrations";
import { pushShopifyStockAction, setShopifyInventoryOwnerAction, syncShopifyProductsAction } from "@/actions/shopify";
import { updateProductOperationalSettingsAction } from "@/actions/products";
import { adjustInventoryAction } from "@/actions/inventory";
import { planShopifyStockPush, pushStockForShopifyOwner, pushStockToShopify } from "@/lib/integrations/shopify/sync/stock-push";
import { pushStockAfterLocalChange } from "@/lib/integrations/shared/auto-push";
import { inventoryOwnerOf } from "@/lib/integrations/woocommerce/store-settings";
import type { ShopifyClient } from "@/lib/integrations/shopify/client";
import { ShopifyThrottledError, ShopifyUserError } from "@/lib/integrations/shopify/errors";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { FAKE_ACCESS_TOKEN, FAKE_SHOP_DOMAIN, emptyFakeShopifyStore, installFakeShopifyServer, type FakeProduct, type FakeShopifyState } from "../helpers/fake-shopify";

/**
 * Shopify stock safety (same contract as WooCommerce's, adapted to Shopify's
 * per-location model): « Qui gère le stock ? » per connection, the user's
 * « Suivre le stock » kept, one plan for the bulk and the automatic push,
 * each row pushed with its OWN sellable number at its OWN location, never a
 * 0 for a missing row. Every Shopify call is answered by the local fake.
 */

let state: FakeShopifyState;

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  vi.stubEnv("SHOPIFY_INTEGRATION_ENABLED", "true");
  state = emptyFakeShopifyStore();
  installFakeShopifyServer(state);
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const LOC_A = "gid://shopify/Location/10";
const LOC_B = "gid://shopify/Location/11";

async function connect(config: Record<string, unknown> = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ provider: "SHOPIFY", siteUrl: FAKE_SHOP_DOMAIN, apiKey: FAKE_ACCESS_TOKEN, apiSecret: "" })) fd.set(k, v);
  const res = await connectIntegrationAction(fd);
  if (!res.ok) throw new Error(res.error);
  if (Object.keys(config).length) {
    const integration = await prisma.integration.findFirstOrThrow({ where: { provider: "SHOPIFY" } });
    await prisma.integration.update({ where: { id: integration.id }, data: { config: { ...(integration.config as object), ...config } } });
  }
}

const simple = (n: number, sku: string, tracked: boolean, levels: { locationId: string; available: number }[]): FakeProduct => ({
  id: `gid://shopify/Product/${n}`,
  title: `Produit ${sku}`,
  handle: sku.toLowerCase(),
  status: "ACTIVE",
  variants: [{ id: `gid://shopify/ProductVariant/${n}1`, title: "Default Title", sku, price: "50.00", inventoryItemId: `gid://shopify/InventoryItem/${n}1`, tracked, levels }],
});

const variable = (n: number, tracked: boolean): FakeProduct => ({
  id: `gid://shopify/Product/${n}`,
  title: "Tee",
  handle: "tee",
  status: "ACTIVE",
  variants: [
    { id: `gid://shopify/ProductVariant/${n}1`, title: "S", sku: "TEE-S", price: "90.00", inventoryItemId: `gid://shopify/InventoryItem/${n}1`, tracked, levels: [{ locationId: LOC_A, available: 4 }] },
    { id: `gid://shopify/ProductVariant/${n}2`, title: "M", sku: "TEE-M", price: "90.00", inventoryItemId: `gid://shopify/InventoryItem/${n}2`, tracked, levels: [{ locationId: LOC_A, available: 6 }, { locationId: LOC_B, available: 2 }] },
  ],
});

async function sync() {
  const res = await syncShopifyProductsAction();
  expect(res.ok).toBe(true);
  return res.ok ? res.data.summary : null;
}

const tracked = async (sku: string) => (await prisma.product.findFirstOrThrow({ where: { sku } })).trackInventory;

describe("ownership and tracking on import", () => {
  it("ASODITECH (default): Shopify's flag seeds a new product only; the user's choice survives syncs; rows only from reported quantities", async () => {
    state.locations = [{ id: LOC_A, name: "Entrepôt", isActive: true }];
    state.products = [simple(501, "SUIVI", true, [{ locationId: LOC_A, available: 20 }]), simple(502, "LIBRE", false, [])];
    await loginAsTestUser({ role: "ADMIN" });
    await connect();
    const first = await sync();
    expect(await tracked("SUIVI")).toBe(true);
    expect(await tracked("LIBRE")).toBe(false);
    expect(first?.notes.join("\n")).toContain("« Produit LIBRE » importé sans suivi de stock");
    expect(await prisma.inventoryItem.count()).toBe(1);

    await prisma.product.updateMany({ where: { sku: "SUIVI" }, data: { trackInventory: false } });
    await prisma.product.updateMany({ where: { sku: "LIBRE" }, data: { trackInventory: true } });
    const second = await sync();
    expect(await tracked("SUIVI")).toBe(false);
    expect(await tracked("LIBRE")).toBe(true);
    expect(second?.notes.join("\n")).toContain("ASODITECH n'active pas ce suivi sur Shopify");
    expect(await prisma.inventoryItem.count()).toBe(1);
    expect(state.stockUpdates).toHaveLength(0); // a sync never pushes
  });

  it("the store manages the stock: no row onboarded, Shopify's flag keeps syncing (store-owned behaviour)", async () => {
    state.locations = [{ id: LOC_A, name: "Entrepôt", isActive: true }];
    state.products = [simple(501, "SUIVI", true, [{ locationId: LOC_A, available: 20 }]), variable(600, true)];
    await loginAsTestUser({ role: "ADMIN" });
    await connect({ inventoryOwner: "STORE" });
    await sync();
    await prisma.product.updateMany({ where: { sku: "SUIVI" }, data: { trackInventory: false } });
    await sync();
    expect(await tracked("SUIVI")).toBe(true);
    expect(await prisma.inventoryItem.count()).toBe(0);
  });

  it("a variable product: each variant's row at each location from Shopify's own number; the parent stays untracked until the user decides (flagged)", async () => {
    state.locations = [{ id: LOC_A, name: "Entrepôt A", isActive: true }, { id: LOC_B, name: "Entrepôt B", isActive: true }];
    state.products = [variable(600, true)];
    await loginAsTestUser({ role: "ADMIN" });
    await connect();
    const summary = await sync();
    const rows = await prisma.inventoryItem.findMany({ include: { variation: true, warehouse: true } });
    expect(rows.map((r) => [r.variation?.sku, r.warehouse.externalId, r.quantityOnHand]).sort()).toEqual([
      ["TEE-M", LOC_A, 6],
      ["TEE-M", LOC_B, 2],
      ["TEE-S", LOC_A, 4], // no row for TEE-S at B: Shopify reports nothing there — never a 0
    ]);
    expect(summary?.notes.join("\n")).toContain("Shopify suit le stock de 2 variante(s), mais le suivi du stock est désactivé dans ASODITECH");
    expect(await pushShopifyStockAction()).toMatchObject({ ok: true });
    expect(state.stockUpdates).toHaveLength(0);
  });
});

describe("push: one plan for bulk and automatic, own row, own location", () => {
  async function seedTrackedVariable() {
    state.locations = [{ id: LOC_A, name: "Entrepôt A", isActive: true }, { id: LOC_B, name: "Entrepôt B", isActive: true }];
    state.products = [variable(600, true)];
    await loginAsTestUser({ role: "ADMIN" });
    await connect();
    await sync();
    const parent = await prisma.product.findFirstOrThrow({ where: { externalId: "gid://shopify/Product/600" } });
    await prisma.product.update({ where: { id: parent.id }, data: { trackInventory: true } }); // the user's decision
    const m = await prisma.productVariation.findFirstOrThrow({ where: { sku: "TEE-M" } });
    const mA = await prisma.inventoryItem.findFirstOrThrow({ where: { variationId: m.id, warehouse: { externalId: LOC_A } } });
    await prisma.inventoryItem.update({ where: { id: mA.id }, data: { quantityReserved: 2 } });
    return { parent, m, mA };
  }

  it("each row: on hand − reserved at its own location; bulk and automatic agree; the parent is never pushed", async () => {
    const { parent, m } = await seedTrackedVariable();
    expect(await pushShopifyStockAction()).toMatchObject({ ok: true });
    const bulk = [...state.stockUpdates].sort((a, b) => (a.inventoryItemId + a.locationId).localeCompare(b.inventoryItemId + b.locationId));
    expect(bulk).toEqual([
      { inventoryItemId: "gid://shopify/InventoryItem/6001", locationId: LOC_A, quantity: 4 },
      { inventoryItemId: "gid://shopify/InventoryItem/6002", locationId: LOC_A, quantity: 4 },
      { inventoryItemId: "gid://shopify/InventoryItem/6002", locationId: LOC_B, quantity: 2 },
    ]);

    state.stockUpdates.length = 0;
    await pushStockAfterLocalChange({ variationIds: [m.id], productIds: [parent.id] });
    expect([...state.stockUpdates].sort((a, b) => a.locationId.localeCompare(b.locationId))).toEqual([
      { inventoryItemId: "gid://shopify/InventoryItem/6002", locationId: LOC_A, quantity: 4 },
      { inventoryItemId: "gid://shopify/InventoryItem/6002", locationId: LOC_B, quantity: 2 },
    ]);
    // echo guard stamped per row (each location its own number), not per inventory item
    const stamped = await prisma.inventoryItem.findMany({ where: { variationId: m.id }, include: { warehouse: true } });
    expect(Object.fromEntries(stamped.map((r) => [r.warehouse.externalId, r.lastPushedQuantity]))).toEqual({ [LOC_A]: 4, [LOC_B]: 2 });
  });

  it("damaged units leave on-hand (never pushed), reservations are subtracted", async () => {
    const { m, mA } = await seedTrackedVariable();
    const fd = new FormData();
    for (const [k, v] of Object.entries({ variationId: m.id, warehouseId: mA.warehouseId, type: "ENDOMMAGE", quantity: "3", reason: "Casse" })) fd.set(k, v);
    expect(await adjustInventoryAction(fd)).toMatchObject({ ok: true }); // the adjustment pushes automatically
    expect(state.stockUpdates.find((u) => u.inventoryItemId.endsWith("/6002") && u.locationId === LOC_A)).toMatchObject({ quantity: 1 }); // 6 − 3 damaged − 2 reserved
  });

  it("refusals send nothing: untracked parent, store-owned stock, Shopify kill switch off", async () => {
    const { parent, m } = await seedTrackedVariable();
    await prisma.product.update({ where: { id: parent.id }, data: { trackInventory: false } });
    expect((await planShopifyStockPush({ variationId: m.id }, "ASODITECH")).map((p) => (p.ok ? "ok" : p.reason))).toEqual(["not_tracked", "not_tracked"]);
    await pushStockAfterLocalChange({ variationIds: [m.id] });
    expect(state.stockUpdates).toHaveLength(0);

    await prisma.product.update({ where: { id: parent.id }, data: { trackInventory: true } });
    expect(await setShopifyInventoryOwnerAction("STORE")).toMatchObject({ ok: true });
    await pushStockAfterLocalChange({ variationIds: [m.id] });
    const bulk = await pushShopifyStockAction();
    expect(bulk.ok && bulk.data.summary.notes).toEqual(["La boutique gère le stock des produits importés : ASODITECH n'y envoie aucun stock."]);
    expect(state.stockUpdates).toHaveLength(0);

    expect(await setShopifyInventoryOwnerAction("ASODITECH")).toMatchObject({ ok: true });
    vi.stubEnv("SHOPIFY_INTEGRATION_ENABLED", "false");
    await pushStockAfterLocalChange({ variationIds: [m.id] });
    expect(state.stockUpdates).toHaveLength(0);
    vi.stubEnv("SHOPIFY_INTEGRATION_ENABLED", "true");
    await pushStockAfterLocalChange({ variationIds: [m.id] });
    expect(state.stockUpdates).toHaveLength(2);
  });
});

describe("identity, location and company checks (fake client)", () => {
  function fakeClient(fail = false) {
    const batches: { inventoryItemId: string; locationId: string; quantity: number }[][] = [];
    const client = {
      async *listAllLocations() {
        yield [{ id: LOC_A, name: "A", isActive: true }];
      },
      async setInventoryQuantities(entries: { inventoryItemId: string; locationId: string; quantity: number }[]) {
        if (fail) throw new Error("HTTP 500 token=shpat_secret");
        batches.push(entries);
      },
    } as unknown as ShopifyClient;
    return { client, batches };
  }

  async function seed() {
    const locA = await prisma.warehouse.create({ data: { name: "A", source: "SHOPIFY", externalId: LOC_A } });
    const local = await prisma.warehouse.create({ data: { name: "Local", isDefault: true } });
    const product = await prisma.product.create({ data: { name: "P", sku: "P", price: 1, source: "SHOPIFY", externalId: "gid://shopify/Product/1", trackInventory: true, status: "ACTIF" } });
    const row = await prisma.inventoryItem.create({ data: { warehouseId: locA.id, productId: product.id, quantityOnHand: 9, externalId: "gid://shopify/InventoryItem/1" } });
    return { locA, local, product, row };
  }

  it("a row at a non-Shopify warehouse, a missing row, an INTERNE product: nothing sent", async () => {
    const { local, product, row } = await seed();
    await prisma.inventoryItem.delete({ where: { id: row.id } });
    await prisma.inventoryItem.create({ data: { warehouseId: local.id, productId: product.id, quantityOnHand: 40, externalId: "gid://shopify/InventoryItem/1" } });
    const internal = await prisma.product.create({ data: { name: "I", sku: "I", price: 1, trackInventory: true } });
    const { client, batches } = fakeClient();
    expect(await pushStockForShopifyOwner(client, { productId: product.id })).toBe(false);
    expect(await pushStockForShopifyOwner(client, { productId: internal.id })).toBe(false);
    await pushStockToShopify(client);
    expect(batches).toHaveLength(0);
  });

  it("the same inventory item on two different units, an invalid gid, a variable parent's own row → refused with a note; valid rows still pushed", async () => {
    const { locA, product } = await seed();
    const twin = await prisma.product.create({ data: { name: "T", sku: "T", price: 1, source: "SHOPIFY", externalId: "gid://shopify/Product/2", trackInventory: true } });
    await prisma.inventoryItem.create({ data: { warehouseId: locA.id, productId: twin.id, quantityOnHand: 3, externalId: "gid://shopify/InventoryItem/1" } });
    const odd = await prisma.product.create({ data: { name: "O", sku: "O", price: 1, source: "SHOPIFY", externalId: "gid://shopify/Product/3", trackInventory: true } });
    await prisma.inventoryItem.create({ data: { warehouseId: locA.id, productId: odd.id, quantityOnHand: 3, externalId: "12345" } });
    const parent = await prisma.product.create({ data: { name: "V", sku: "V", price: 1, source: "SHOPIFY", externalId: "gid://shopify/Product/4", trackInventory: true } });
    await prisma.productVariation.create({ data: { productId: parent.id, sku: "V-S", attributes: {}, source: "SHOPIFY", externalId: "gid://shopify/ProductVariant/41" } });
    await prisma.inventoryItem.create({ data: { warehouseId: locA.id, productId: parent.id, quantityOnHand: 99, externalId: "gid://shopify/InventoryItem/4" } });
    const ok = await prisma.product.create({ data: { name: "K", sku: "K", price: 1, source: "SHOPIFY", externalId: "gid://shopify/Product/5", trackInventory: true } });
    await prisma.inventoryItem.create({ data: { warehouseId: locA.id, productId: ok.id, quantityOnHand: 6, quantityReserved: 1, externalId: "gid://shopify/InventoryItem/5" } });

    const { client, batches } = fakeClient();
    const summary = await pushStockToShopify(client);
    expect(batches.flat()).toEqual([{ inventoryItemId: "gid://shopify/InventoryItem/5", locationId: LOC_A, quantity: 5 }]);
    expect(summary.notes).toEqual(
      expect.arrayContaining([
        "Article P : stock non envoyé à Shopify (identifiant Shopify partagé par plusieurs articles — à corriger).",
        "Article O : stock non envoyé à Shopify (identifiant Shopify invalide).",
      ])
    );
    expect((await planShopifyStockPush({ productId: parent.id }, "ASODITECH"))[0]).toEqual({ ok: false, reason: "variable_parent" });
    expect((await planShopifyStockPush({ productId: product.id }, "ASODITECH"))[0]).toEqual({ ok: false, reason: "ambiguous_link" });
  });

  it("another company's rows are invisible; a failed batch reports a sanitized note and writes no stock", async () => {
    const { row } = await seed();
    const TENANT_B = "tenant-b-shopify-push";
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "B", slug: TENANT_B } });
    const bLoc = await prismaBase.warehouse.create({ data: { tenantId: TENANT_B, name: "B", source: "SHOPIFY", externalId: "gid://shopify/Location/99" } });
    const bProduct = await prismaBase.product.create({ data: { tenantId: TENANT_B, name: "B", sku: "B", price: 1, source: "SHOPIFY", externalId: "gid://shopify/Product/99", trackInventory: true } });
    await prismaBase.inventoryItem.create({ data: { tenantId: TENANT_B, warehouseId: bLoc.id, productId: bProduct.id, quantityOnHand: 50, externalId: "gid://shopify/InventoryItem/99" } });

    await loginAsTestUser({ role: "ADMIN" });
    expect(await planShopifyStockPush({ productId: bProduct.id }, "ASODITECH")).toEqual([]);
    const ok = fakeClient();
    await pushStockToShopify(ok.client);
    expect(ok.batches.flat().map((e) => e.inventoryItemId)).toEqual(["gid://shopify/InventoryItem/1"]);

    const before = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: row.id } });
    const failing = fakeClient(true);
    const summary = await pushStockToShopify(failing.client);
    expect(summary).toMatchObject({ failed: 1, updated: 0 });
    expect(summary.notes.join(" ")).not.toContain("shpat_secret");
    expect(await prisma.inventoryItem.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ quantityOnHand: before.quantityOnHand, lastPushedQuantity: 9 });
    expect(await prisma.inventoryMovement.count()).toBe(0);
  });
});

describe("settings and authorisation", () => {
  it("the Shopify « Qui gère le stock ? » is validated, audited, per company and refused without integrations.manage or with the kill switch off", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    expect(await setShopifyInventoryOwnerAction("STORE")).toMatchObject({ ok: false, error: "Configurez d'abord la connexion Shopify." });
    await connect();
    expect(await setShopifyInventoryOwnerAction("BOTH")).toMatchObject({ ok: false, error: "Choix invalide." });
    expect(await setShopifyInventoryOwnerAction("STORE")).toEqual({ ok: true, data: { owner: "STORE" } });
    const integration = await prisma.integration.findFirstOrThrow({ where: { provider: "SHOPIFY" } });
    expect(inventoryOwnerOf(integration.config)).toBe("STORE");
    expect((await prisma.auditEvent.findFirstOrThrow({ where: { entityId: integration.id, action: "integration.updated" }, orderBy: { createdAt: "desc" } })).metadata).toMatchObject({
      provider: "SHOPIFY",
      change: "inventory_owner",
      previous: "ASODITECH",
      owner: "STORE",
      linkedStockRows: 0,
    });

    await loginAsTestUser({ role: "MANAGER" });
    await expect(setShopifyInventoryOwnerAction("ASODITECH")).rejects.toThrow(/autoris|permission/i);
    await expect(pushShopifyStockAction()).rejects.toThrow(/autoris|permission/i);
    await loginAsTestUser({ role: "SUPPORT" });
    const fd = new FormData();
    fd.set("id", "x");
    fd.set("lowStockThreshold", "5");
    await expect(updateProductOperationalSettingsAction(fd)).rejects.toThrow(/autoris|permission/i);

    await loginAsTestUser({ role: "ADMIN" });
    vi.stubEnv("SHOPIFY_INTEGRATION_ENABLED", "false");
    expect(await setShopifyInventoryOwnerAction("ASODITECH")).toMatchObject({ ok: false, error: "L'intégration Shopify n'est pas encore disponible." });
    expect(await pushShopifyStockAction()).toMatchObject({ ok: false });
    expect(state.stockUpdates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Location validity (Shopify's own `isActive`) and per-row isolation of a
// rejected batch — fake clients only.
// ---------------------------------------------------------------------------

describe("location guard and rejected batches", () => {
  type Entry = { inventoryItemId: string; locationId: string; quantity: number };
  function scriptedClient(opts: { inactive?: string[]; listed?: string[]; listFails?: boolean; reject?: (entries: Entry[]) => Error | null }) {
    const calls: Entry[][] = [];
    const client = {
      async *listAllLocations() {
        if (opts.listFails) throw new ShopifyThrottledError("Trop de requêtes");
        yield [...(opts.listed ?? []).map((id) => ({ id, name: id, isActive: true })), ...(opts.inactive ?? []).map((id) => ({ id, name: id, isActive: false }))];
      },
      async setInventoryQuantities(entries: Entry[]) {
        calls.push(entries);
        const error = opts.reject?.(entries);
        if (error) throw error;
      },
    } as unknown as ShopifyClient;
    return { client, calls };
  }

  async function seedRows(count: number, locations: string[]) {
    const warehouses = await Promise.all(locations.map((loc, i) => prisma.warehouse.create({ data: { name: `Loc ${i}`, source: "SHOPIFY", externalId: loc } })));
    const rows: { productId: string; sku: string; itemGid: string; byLocation: Record<string, string> }[] = [];
    for (let n = 1; n <= count; n++) {
      const product = await prisma.product.create({
        data: { name: `P${n}`, sku: `P${n}`, price: 1, source: "SHOPIFY", externalId: `gid://shopify/Product/${n}`, trackInventory: true },
      });
      const itemGid = `gid://shopify/InventoryItem/${n}`;
      const byLocation: Record<string, string> = {};
      for (const [i, w] of warehouses.entries()) {
        byLocation[w.externalId!] = (await prisma.inventoryItem.create({ data: { warehouseId: w.id, productId: product.id, quantityOnHand: 10 * n + i, externalId: itemGid } })).id;
      }
      rows.push({ productId: product.id, sku: product.sku, itemGid, byLocation });
    }
    return rows;
  }
  const stamp = async (rowId: string) => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: rowId } })).lastPushedQuantity;

  it("a location Shopify reports deactivated is refused by both pushes — nothing redirected, mapping and stamp untouched", async () => {
    const [p] = await seedRows(1, [LOC_A, LOC_B]);
    const bulk = scriptedClient({ listed: [LOC_A], inactive: [LOC_B] });
    const summary = await pushStockToShopify(bulk.client);
    expect(bulk.calls.flat()).toEqual([{ inventoryItemId: p.itemGid, locationId: LOC_A, quantity: 10 }]);
    expect(summary).toMatchObject({ updated: 1, skipped: 1, failed: 0 });
    expect(summary.notes).toContain("Article P1 : stock non envoyé à Shopify (emplacement désactivé sur Shopify).");
    expect(await stamp(p.byLocation[LOC_B])).toBeNull();
    expect(await prisma.warehouse.count({ where: { source: "SHOPIFY", externalId: LOC_B } })).toBe(1);

    const auto = scriptedClient({ listed: [LOC_A], inactive: [LOC_B] });
    expect(await pushStockForShopifyOwner(auto.client, { productId: p.productId })).toBe(true);
    expect(auto.calls.flat()).toEqual([{ inventoryItemId: p.itemGid, locationId: LOC_A, quantity: 10 }]);
    expect((await planShopifyStockPush({ productId: p.productId }, "ASODITECH", new Set([LOC_B]))).map((x) => (x.ok ? x.entry.locationId : x.reason)).sort()).toEqual(
      [LOC_A, "inactive_location"].sort()
    );
  });

  it("a location absent from Shopify's list is not assumed inactive (Shopify's answer to the push decides)", async () => {
    const [p] = await seedRows(1, [LOC_A]);
    const { client, calls } = scriptedClient({ listed: [] });
    await pushStockToShopify(client);
    expect(calls.flat()).toEqual([{ inventoryItemId: p.itemGid, locationId: LOC_A, quantity: 10 }]);
  });

  it("the location list cannot be read → nothing is sent, nothing stamped (both pushes)", async () => {
    const [p] = await seedRows(1, [LOC_A]);
    const { client, calls } = scriptedClient({ listFails: true });
    const summary = await pushStockToShopify(client);
    expect(summary).toMatchObject({ updated: 0, failed: 1 });
    expect(summary.notes).toContain("Impossible de vérifier les emplacements Shopify : aucun stock envoyé.");
    expect(await pushStockForShopifyOwner(client, { productId: p.productId })).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await stamp(p.byLocation[LOC_A])).toBeNull();
  });

  it("a batch Shopify rejects is re-sent row by row: the 24 good rows succeed and are stamped, only the bad one fails", async () => {
    const rows = await seedRows(30, [LOC_A]); // 2 batches: 25 + 5
    const bad = rows[7].itemGid;
    const { client, calls } = scriptedClient({ listed: [LOC_A], reject: (entries) => (entries.some((e) => e.inventoryItemId === bad) ? new ShopifyUserError("refusé") : null) });
    const summary = await pushStockToShopify(client);

    expect(summary).toMatchObject({ updated: 29, failed: 1 });
    expect(summary.notes).toEqual(expect.arrayContaining(["1 lot(s) refusé(s) par Shopify : renvoyé(s) article par article.", "Article P8 : échec de l'envoi du stock à Shopify."]));
    expect(calls.map((c) => c.length)).toEqual([25, ...Array(25).fill(1), 5]); // rejected batch, its 25 rows alone, then the second batch
    for (const r of rows) expect(await stamp(r.byLocation[LOC_A])).toBe(r.itemGid === bad ? null : Number(r.sku.slice(1)) * 10);
    expect(await prisma.inventoryMovement.count()).toBe(0);
  });

  it("network / throttling errors are never retried row by row: the batch fails, nothing is stamped", async () => {
    const rows = await seedRows(3, [LOC_A]);
    const { client, calls } = scriptedClient({ listed: [LOC_A], reject: () => new ShopifyThrottledError("Trop de requêtes") });
    const summary = await pushStockToShopify(client);
    expect(summary).toMatchObject({ updated: 0, failed: 3 });
    expect(calls).toHaveLength(1);
    for (const r of rows) expect(await stamp(r.byLocation[LOC_A])).toBeNull();
  });

  it("the automatic push uses the same per-row fallback: the good location is stamped, the rejected one is not", async () => {
    const [p] = await seedRows(1, [LOC_A, LOC_B]);
    const { client, calls } = scriptedClient({ listed: [LOC_A, LOC_B], reject: (entries) => (entries.some((e) => e.locationId === LOC_B) ? new ShopifyUserError("refusé") : null) });
    expect(await pushStockForShopifyOwner(client, { productId: p.productId })).toBe(true);
    expect(calls.map((c) => c.length)).toEqual([2, 1, 1]);
    expect(await stamp(p.byLocation[LOC_A])).toBe(10);
    expect(await stamp(p.byLocation[LOC_B])).toBeNull();
  });
});
