import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import { pushWooCommerceStockAction, setWooCommerceInventoryOwnerAction, syncWooCommerceProductsAction } from "@/actions/woocommerce";
import { updateProductOperationalSettingsAction } from "@/actions/products";
import { adjustInventoryAction } from "@/actions/inventory";
import { importProduct } from "@/lib/integrations/woocommerce/sync";
import { planWooCommerceStockPush, pushStockForWooCommerceOwner, pushStockToWooCommerce } from "@/lib/integrations/woocommerce/sync/stock-push";
import { pushStockAfterLocalChange } from "@/lib/integrations/shared/auto-push";
import { loadWooCommerceClient } from "@/lib/integrations/woocommerce/client-loader";
import { wcProductSchema } from "@/lib/integrations/woocommerce/types";
import type { WooCommerceClient } from "@/lib/integrations/woocommerce/client";
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
 * Phase 6 final decisions (WooCommerce only — Shopify is a later phase):
 *  A. ASODITECH manages the stock → an import never switches `trackInventory`;
 *  B. variation stock is pushed only from THAT variation's own rows, with the
 *     same plan for the bulk « Pousser le stock » and the automatic push;
 *  C. a unit the store does not track (or gives no quantity for) gets no row,
 *     no 0, no push — until an authorised user turns tracking on.
 * Every store call is answered locally (fake server / fake client).
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

async function sync() {
  const res = await syncWooCommerceProductsAction();
  expect(res.ok).toBe(true);
  return res.ok ? res.data.summary : null;
}

const tracked = async (sku: string) => (await prisma.product.findFirstOrThrow({ where: { sku } })).trackInventory;

// ---------------------------------------------------------------------------
// A + C — tracking ownership on import
// ---------------------------------------------------------------------------

describe("A/C — ASODITECH manages the stock: the store never switches « Suivre le stock »", () => {
  it("a new import takes the store's flag once; afterwards the user's choice survives every sync, both ways", async () => {
    await seedIntegration();
    await loginAsTestUser({ role: "ADMIN" });
    state.products = [simple(101, "SUIVI", true, 5), simple(102, "LIBRE", false, null)];
    const first = await sync();
    expect(await tracked("SUIVI")).toBe(true);
    expect(await tracked("LIBRE")).toBe(false);
    // C: untracked by the store → no row, no 0, and a manual-review note
    expect(await prisma.inventoryItem.count({ where: { product: { sku: "LIBRE" } } })).toBe(0);
    expect(first?.notes.join("\n")).toContain("« Produit LIBRE » importé sans suivi de stock");

    // the user decides the opposite of the store, for both
    await prisma.product.updateMany({ where: { sku: "SUIVI" }, data: { trackInventory: false } });
    await prisma.product.updateMany({ where: { sku: "LIBRE" }, data: { trackInventory: true } });
    const before = await prisma.inventoryItem.findMany({ orderBy: { id: "asc" } });

    const second = await sync();
    expect(await tracked("SUIVI")).toBe(false);
    expect(await tracked("LIBRE")).toBe(true);
    expect(await prisma.inventoryItem.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    expect(await prisma.inventoryMovement.count()).toBe(0);
    expect(second?.notes.join("\n")).toContain("« Produit LIBRE » : stock suivi dans ASODITECH mais pas par la boutique");
    expect(state.stockUpdates).toHaveLength(0); // a sync never pushes
  });

  it("the webhook path (product.updated → importProduct) obeys the same rule", async () => {
    await seedIntegration();
    await loginAsTestUser({ role: "ADMIN" });
    state.products = [simple(101, "SUIVI", true, 5)];
    await sync();
    await prisma.product.updateMany({ where: { sku: "SUIVI" }, data: { trackInventory: false } });

    const loaded = await loadWooCommerceClient();
    const res = await importProduct(loaded!.client, wcProductSchema.parse({ ...simple(101, "SUIVI", true, 9), name: "Renommé" }), { type: "INTEGRATION" });
    expect(res.outcome).toBe("updated");
    expect(await prisma.product.findFirstOrThrow({ where: { sku: "SUIVI" } })).toMatchObject({ name: "Renommé", trackInventory: false });
    expect(await prisma.inventoryItem.findFirstOrThrow({ where: { product: { sku: "SUIVI" } } })).toMatchObject({ quantityOnHand: 5 });
  });

  it("the store manages the stock: its flag keeps syncing as before (store-owned behaviour unchanged)", async () => {
    await seedIntegration({ inventoryOwner: "STORE" });
    await loginAsTestUser({ role: "ADMIN" });
    state.products = [simple(101, "SUIVI", true, 5)];
    await sync();
    await prisma.product.updateMany({ where: { sku: "SUIVI" }, data: { trackInventory: false } });
    await sync();
    expect(await tracked("SUIVI")).toBe(true);
    expect(await prisma.inventoryItem.count()).toBe(0);
  });

  it("a tracked unit without a store quantity, and a variation on the parent's stock, get no row — never 0, never the parent's number", async () => {
    await seedIntegration();
    await loginAsTestUser({ role: "ADMIN" });
    state.products = [
      simple(102, "SANS-QTE", true, null),
      {
        ...simple(104, "VAR", true, 50), // the PARENT manages a stock of 50 (WooCommerce "parent" variations use it)
        type: "variable",
        variations: [1041, 1042, 1043],
        variationList: [
          { id: 1041, sku: "VAR-S", regular_price: "100", manage_stock: true, stock_quantity: 3, attributes: [{ name: "Taille", option: "S" }] },
          { id: 1042, sku: "VAR-M", regular_price: "100", manage_stock: "parent", stock_quantity: 50, attributes: [{ name: "Taille", option: "M" }] },
          { id: 1043, sku: "VAR-L", regular_price: "100", manage_stock: true, stock_quantity: null, attributes: [{ name: "Taille", option: "L" }] },
        ],
      },
    ];
    const summary = await sync();

    const items = await prisma.inventoryItem.findMany({ include: { variation: true, product: true } });
    expect(items.map((i) => [i.variation?.sku ?? i.product?.sku, i.quantityOnHand]).sort()).toEqual([
      ["VAR", 50], // the parent's own row (its own number), never copied onto a variation
      ["VAR-S", 3],
    ]);
    expect(await prisma.productVariation.count({ where: { source: "WOOCOMMERCE" } })).toBe(3); // the "parent" variation still imports
    const notes = summary?.notes.join("\n") ?? "";
    expect(notes).toContain("« Produit SANS-QTE » : la boutique suit son stock sans indiquer de quantité");
    expect(notes).toContain("« Produit VAR » : 2 variante(s) sans quantité propre");
  });

  it("a variable product untracked in ASODITECH whose variations the store manages is flagged, nothing pushed", async () => {
    await seedIntegration();
    await loginAsTestUser({ role: "ADMIN" });
    state.products = [
      {
        ...simple(104, "VAR", false, null),
        type: "variable",
        variations: [1041],
        variationList: [{ id: 1041, sku: "VAR-S", regular_price: "100", manage_stock: true, stock_quantity: 3, attributes: [{ name: "Taille", option: "S" }] }],
      },
    ];
    const summary = await sync();
    expect(await tracked("VAR")).toBe(false);
    expect(summary?.notes.join("\n")).toContain("le suivi du stock est désactivé dans ASODITECH — rien n'est envoyé");

    expect(await pushWooCommerceStockAction()).toMatchObject({ ok: true });
    expect(state.stockUpdates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// B — variation stock push: one plan, own rows only
// ---------------------------------------------------------------------------

function fakeWooClient(failVariationIds: number[] = []) {
  const updates: { productId: number; quantity: number; variationId?: number }[] = [];
  const client = {
    async updateStock(productId: number, quantity: number, variationId?: number) {
      if (variationId && failVariationIds.includes(variationId)) throw new Error("HTTP 500 <html>secret body</html>");
      updates.push({ productId, quantity, variationId });
    },
  } as unknown as WooCommerceClient;
  return { client, updates };
}

/** Variable WooCommerce product #700 (parent row of 999 units — must never be used) and its variations. */
async function seedVariable(opts: { trackInventory?: boolean } = {}) {
  const parent = await prisma.product.create({
    data: { name: "Tee", sku: "TEE", price: 100, status: "ACTIF", source: "WOOCOMMERCE", externalId: "700", trackInventory: opts.trackInventory ?? true },
  });
  await prisma.inventoryItem.create({ data: { warehouseId, productId: parent.id, quantityOnHand: 999 } });
  const variation = (sku: string, externalId: string | null, source: "WOOCOMMERCE" | "INTERNE" = "WOOCOMMERCE") =>
    prisma.productVariation.create({ data: { productId: parent.id, sku, attributes: { Taille: sku }, source, externalId } });
  const s = await variation("TEE-S", "7001");
  const m = await variation("TEE-M", "7002");
  const l = await variation("TEE-L", "7003"); // no stock row
  const local = await variation("TEE-XL", null, "INTERNE"); // ASODITECH-only variation
  await prisma.inventoryItem.create({ data: { warehouseId, variationId: s.id, quantityOnHand: 10, quantityReserved: 3 } });
  await prisma.inventoryItem.create({ data: { warehouseId, variationId: m.id, quantityOnHand: 2, quantityReserved: 5 } });
  await prisma.inventoryItem.create({ data: { warehouseId, variationId: local.id, quantityOnHand: 4 } });
  return { parent, s, m, l, local };
}

describe("B — variable products: each variation its own sellable stock", () => {
  it("bulk: each linked variation gets its OWN rows' sellable number (on hand − reserved, never below 0); parent / missing-row / local variations get nothing", async () => {
    await seedVariable();
    const { client, updates } = fakeWooClient();
    const summary = await pushStockToWooCommerce(client);

    expect(updates).toEqual([
      { productId: 700, quantity: 7, variationId: 7001 },
      { productId: 700, quantity: 0, variationId: 7002 }, // a real 0: 2 on hand, 5 reserved
    ]);
    expect(summary).toMatchObject({ updated: 2, skipped: 2, failed: 0 });
  });

  it("automatic push uses the very same plan: same numbers, same refusals", async () => {
    const { parent, s, m, l, local } = await seedVariable();
    expect(await planWooCommerceStockPush({ variationId: s.id }, "ASODITECH")).toMatchObject({ ok: true, wcProductId: 700, wcVariationId: 7001, sellable: 7 });
    expect(await planWooCommerceStockPush({ variationId: m.id }, "ASODITECH")).toMatchObject({ ok: true, sellable: 0 });
    expect(await planWooCommerceStockPush({ variationId: l.id }, "ASODITECH")).toEqual({ ok: false, reason: "no_inventory_row" });
    expect(await planWooCommerceStockPush({ variationId: local.id }, "ASODITECH")).toEqual({ ok: false, reason: "not_linked" });
    // the parent's own row (999) is never sent — neither for the parent nor in place of a variation
    expect(await planWooCommerceStockPush({ productId: parent.id }, "ASODITECH")).toEqual({ ok: false, reason: "variable_parent" });

    const { client, updates } = fakeWooClient();
    for (const owner of [{ productId: parent.id }, { variationId: s.id }, { variationId: l.id }, { variationId: local.id }]) {
      await pushStockForWooCommerceOwner(client, owner);
    }
    expect(updates).toEqual([{ productId: 700, quantity: 7, variationId: 7001 }]);
  });

  it("untracked parent → no variation pushed by either path (the automatic push used to ignore the flag)", async () => {
    const { s } = await seedVariable({ trackInventory: false });
    const { client, updates } = fakeWooClient();
    await pushStockToWooCommerce(client);
    expect(await pushStockForWooCommerceOwner(client, { variationId: s.id })).toBe(false);
    expect(await planWooCommerceStockPush({ variationId: s.id }, "ASODITECH")).toEqual({ ok: false, reason: "not_tracked" });
    expect(updates).toHaveLength(0);
  });

  it("the store manages the stock → nothing is pushed, by either path", async () => {
    const { s } = await seedVariable();
    const { client, updates } = fakeWooClient();
    const summary = await pushStockToWooCommerce(client, { inventoryOwner: "STORE" });
    expect(await pushStockForWooCommerceOwner(client, { variationId: s.id }, { inventoryOwner: "STORE" })).toBe(false);
    expect(updates).toHaveLength(0);
    expect(summary.notes).toEqual(["La boutique gère le stock des produits importés : ASODITECH n'y envoie aucun stock."]);
  });

  it("ambiguous or invalid store ids → refused with a note, the other variations still pushed", async () => {
    const { parent, s, m } = await seedVariable();
    await prisma.productVariation.update({ where: { id: m.id }, data: { externalId: "7001" } }); // two variations claim #7001
    const odd = await prisma.productVariation.create({ data: { productId: parent.id, sku: "TEE-ODD", attributes: {}, source: "WOOCOMMERCE", externalId: "70a" } });
    const echo = await prisma.productVariation.create({ data: { productId: parent.id, sku: "TEE-ECHO", attributes: {}, source: "WOOCOMMERCE", externalId: "700" } });
    const ok = await prisma.productVariation.create({ data: { productId: parent.id, sku: "TEE-OK", attributes: {}, source: "WOOCOMMERCE", externalId: "7009" } });
    for (const v of [odd, echo, ok]) await prisma.inventoryItem.create({ data: { warehouseId, variationId: v.id, quantityOnHand: 6 } });

    const { client, updates } = fakeWooClient();
    const summary = await pushStockToWooCommerce(client);
    expect(updates).toEqual([{ productId: 700, quantity: 6, variationId: 7009 }]);
    expect(summary.notes).toEqual(
      expect.arrayContaining([
        "Variation TEE-S : stock non envoyé (identifiant WooCommerce partagé par plusieurs produits — à corriger).",
        "Variation TEE-ODD : stock non envoyé (identifiant WooCommerce invalide).",
        "Variation TEE-ECHO : stock non envoyé (identifiant WooCommerce partagé par plusieurs produits — à corriger).",
      ])
    );
    expect(await planWooCommerceStockPush({ variationId: s.id }, "ASODITECH")).toEqual({ ok: false, reason: "ambiguous_link" });
    expect(await planWooCommerceStockPush({ variationId: odd.id }, "ASODITECH")).toEqual({ ok: false, reason: "invalid_remote_id" });
  });

  it("another company's variation is invisible: refused, nothing sent", async () => {
    await seedVariable();
    const TENANT_B = "tenant-b-variation-push";
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "B", slug: TENANT_B } });
    const bWarehouse = await prismaBase.warehouse.create({ data: { tenantId: TENANT_B, name: "B", isDefault: true } });
    const bParent = await prismaBase.product.create({ data: { tenantId: TENANT_B, name: "B", sku: "B", price: 1, source: "WOOCOMMERCE", externalId: "800", trackInventory: true } });
    const bVar = await prismaBase.productVariation.create({ data: { tenantId: TENANT_B, productId: bParent.id, sku: "B-S", attributes: {}, source: "WOOCOMMERCE", externalId: "8001" } });
    await prismaBase.inventoryItem.create({ data: { tenantId: TENANT_B, warehouseId: bWarehouse.id, variationId: bVar.id, quantityOnHand: 50 } });

    await loginAsTestUser({ role: "ADMIN" });
    expect(await planWooCommerceStockPush({ variationId: bVar.id }, "ASODITECH")).toEqual({ ok: false, reason: "not_linked" });
    const { client, updates } = fakeWooClient();
    await pushStockForWooCommerceOwner(client, { variationId: bVar.id });
    await pushStockToWooCommerce(client);
    expect(updates.map((u) => u.variationId)).not.toContain(8001);
  });

  it("one variation failing never corrupts the others, its link, or the stock; retries create no movement or row", async () => {
    const { s } = await seedVariable();
    const before = await prisma.inventoryItem.findMany({ select: { id: true, quantityOnHand: true, quantityReserved: true }, orderBy: { id: "asc" } });

    const { client, updates } = fakeWooClient([7001]);
    const summary = await pushStockToWooCommerce(client);
    expect(updates).toEqual([{ productId: 700, quantity: 0, variationId: 7002 }]);
    expect(summary).toMatchObject({ updated: 1, failed: 1 });
    expect(summary.notes).toContain("Variation TEE-S : échec de l'envoi du stock à WooCommerce.");
    expect(summary.notes.join(" ")).not.toContain("secret body");
    expect(await prisma.productVariation.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ source: "WOOCOMMERCE", externalId: "7001" });

    const retry = fakeWooClient();
    await pushStockToWooCommerce(retry.client);
    await pushStockToWooCommerce(retry.client);
    expect(retry.updates.filter((u) => u.variationId === 7001).map((u) => u.quantity)).toEqual([7, 7]);
    expect(await prisma.inventoryItem.findMany({ select: { id: true, quantityOnHand: true, quantityReserved: true }, orderBy: { id: "asc" } })).toEqual(before);
    expect(await prisma.inventoryMovement.count()).toBe(0);
  });

  it("the automatic push after a local change reads this company's « Qui gère le stock ? »", async () => {
    const { s } = await seedVariable();
    const integration = await seedIntegration({ inventoryOwner: "STORE" });
    await pushStockAfterLocalChange({ variationIds: [s.id] });
    expect(state.stockUpdates).toHaveLength(0);

    await prisma.integration.update({ where: { id: integration.id }, data: { config: { siteUrl: FAKE_STORE_URL } } });
    await pushStockAfterLocalChange({ variationIds: [s.id] });
    expect(state.stockUpdates.map((u) => [u.path.replace(/^.*\/products/, "/products"), (u.body as { stock_quantity: number }).stock_quantity])).toEqual([
      ["/products/700/variations/7001", 7],
    ]);
  });
});

// ---------------------------------------------------------------------------
// C + authorisation — turning tracking on is an explicit, protected decision
// ---------------------------------------------------------------------------

describe("C — enabling tracking is the user's explicit decision, and pushes nothing by itself", () => {
  const form = (id: string, track: boolean) => {
    const fd = new FormData();
    fd.set("id", id);
    if (track) fd.set("trackInventory", "on");
    fd.set("lowStockThreshold", "5");
    return fd;
  };

  it("an authorised user turns tracking on: audited, no row created, no push; the next sync keeps it", async () => {
    await seedIntegration();
    await loginAsTestUser({ role: "ADMIN" });
    state.products = [simple(102, "LIBRE", false, null)];
    await sync();
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "LIBRE" } });

    expect(await updateProductOperationalSettingsAction(form(product.id, true))).toMatchObject({ ok: true });
    expect(await tracked("LIBRE")).toBe(true);
    expect(await prisma.inventoryItem.count()).toBe(0);
    expect(state.stockUpdates).toHaveLength(0);
    expect(await prisma.auditEvent.findFirst({ where: { entityId: product.id, action: "product.updated" } })).toMatchObject({
      previousValue: expect.objectContaining({ trackInventory: false }),
      newValue: expect.objectContaining({ trackInventory: true }),
    });

    await sync();
    expect(await tracked("LIBRE")).toBe(true);
    // still no row: no quantity anywhere → nothing to push (never a 0)
    expect(await pushWooCommerceStockAction()).toMatchObject({ ok: true });
    expect(state.stockUpdates).toHaveLength(0);
  });

  it("users without products.edit cannot change tracking; without integrations.manage cannot push or change the owner", async () => {
    await seedIntegration();
    const product = await prisma.product.create({ data: { name: "P", sku: "P", price: 1, source: "WOOCOMMERCE", externalId: "900", trackInventory: false } });

    await loginAsTestUser({ role: "SUPPORT" });
    await expect(updateProductOperationalSettingsAction(form(product.id, true))).rejects.toThrow(/autoris|permission/i);
    await loginAsTestUser({ role: "MANAGER" });
    await expect(pushWooCommerceStockAction()).rejects.toThrow(/autoris|permission/i);
    expect(await tracked("P")).toBe(false);
    expect(state.stockUpdates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// C1 — damaged units; C4 — switching who manages the stock
// ---------------------------------------------------------------------------

describe("C1 — damaged units are never in the pushed number (they are not on hand)", () => {
  it("an « Endommagé » adjustment moves units out of on-hand into damaged: the push sends on hand − reserved, damaged not subtracted twice", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { s } = await seedVariable(); // TEE-S: 10 on hand, 3 reserved
    const fd = new FormData();
    fd.set("variationId", s.id);
    fd.set("warehouseId", warehouseId);
    fd.set("type", "ENDOMMAGE");
    fd.set("quantity", "2");
    fd.set("reason", "Casse");
    expect(await adjustInventoryAction(fd)).toMatchObject({ ok: true });

    expect(await prisma.inventoryItem.findFirstOrThrow({ where: { variationId: s.id } })).toMatchObject({ quantityOnHand: 8, quantityDamaged: 2, quantityReserved: 3 });
    expect(await planWooCommerceStockPush({ variationId: s.id }, "ASODITECH")).toMatchObject({ ok: true, sellable: 5 });
  });
});

describe("C4 — switching « Qui gère le stock ? » keeps every row and pushes nothing by itself", () => {
  it("to the store: rows kept, no longer pushed (automatic or bulk); back to ASODITECH: nothing sent until the next movement or push", async () => {
    const { s } = await seedVariable();
    await seedIntegration();
    await loginAsTestUser({ role: "ADMIN" });
    const before = await prisma.inventoryItem.findMany({ orderBy: { id: "asc" } });

    expect(await setWooCommerceInventoryOwnerAction("STORE")).toMatchObject({ ok: true });
    await pushStockAfterLocalChange({ variationIds: [s.id] });
    expect(await pushWooCommerceStockAction()).toMatchObject({ ok: true });
    expect(state.stockUpdates).toHaveLength(0);

    expect(await setWooCommerceInventoryOwnerAction("ASODITECH")).toMatchObject({ ok: true });
    expect(state.stockUpdates).toHaveLength(0); // the switch itself sends nothing
    expect(await prisma.inventoryItem.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    expect(await prisma.inventoryMovement.count()).toBe(0);

    await pushStockAfterLocalChange({ variationIds: [s.id] });
    expect(state.stockUpdates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Decision 2026-10-13 — a valid push may switch on WooCommerce's own stock
// management (`manage_stock: true` + the verified number); nothing else may.
// ---------------------------------------------------------------------------

describe("remote tracking is switched on only by a valid push", () => {
  const sent = () =>
    state.stockUpdates.map((u) => ({ path: u.path.replace(/^.*\/products/, "/products"), body: u.body }));

  it("store-untracked simple product, tracked in ASODITECH with a real row: the push turns WooCommerce tracking on with the verified number", async () => {
    await seedIntegration();
    await loginAsTestUser({ role: "ADMIN" });
    const product = await prisma.product.create({ data: { name: "Savon", sku: "SAVON", price: 30, status: "ACTIF", source: "WOOCOMMERCE", externalId: "910", trackInventory: true } });
    await prisma.inventoryItem.create({ data: { warehouseId, productId: product.id, quantityOnHand: 9, quantityReserved: 2, quantityDamaged: 4 } });

    expect(await pushWooCommerceStockAction()).toMatchObject({ ok: true });
    expect(sent()).toEqual([{ path: "/products/910", body: { manage_stock: true, stock_quantity: 7 } }]); // damaged never on hand, reserved subtracted

    state.stockUpdates.length = 0;
    await pushStockAfterLocalChange({ productIds: [product.id] });
    expect(sent()).toEqual([{ path: "/products/910", body: { manage_stock: true, stock_quantity: 7 } }]); // same rule, same number
    expect(await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).toMatchObject({ trackInventory: true }); // local choice untouched
  });

  it("a variation: its own rows only, to its own store id", async () => {
    await seedIntegration();
    await loginAsTestUser({ role: "ADMIN" });
    const { s } = await seedVariable();
    await pushStockAfterLocalChange({ variationIds: [s.id] });
    expect(sent()).toEqual([{ path: "/products/700/variations/7001", body: { manage_stock: true, stock_quantity: 7 } }]);
  });

  it("no request at all — so no remote tracking change — for an untracked product, a missing row, the store's stock, or a non-authorised user", async () => {
    const integration = await seedIntegration();
    await loginAsTestUser({ role: "ADMIN" });
    const untracked = await prisma.product.create({ data: { name: "A", sku: "A", price: 1, source: "WOOCOMMERCE", externalId: "920", trackInventory: false } });
    await prisma.inventoryItem.create({ data: { warehouseId, productId: untracked.id, quantityOnHand: 5 } });
    const noRow = await prisma.product.create({ data: { name: "B", sku: "B", price: 1, source: "WOOCOMMERCE", externalId: "921", trackInventory: true } });

    await pushStockAfterLocalChange({ productIds: [untracked.id, noRow.id] });
    expect(await pushWooCommerceStockAction()).toMatchObject({ ok: true });
    expect(state.stockUpdates).toHaveLength(0);

    const tracked = await prisma.product.create({ data: { name: "C", sku: "C", price: 1, source: "WOOCOMMERCE", externalId: "922", trackInventory: true } });
    await prisma.inventoryItem.create({ data: { warehouseId, productId: tracked.id, quantityOnHand: 5 } });
    await prisma.integration.update({ where: { id: integration.id }, data: { config: { siteUrl: FAKE_STORE_URL, inventoryOwner: "STORE" } } });
    await pushStockAfterLocalChange({ productIds: [tracked.id] });
    expect(await pushWooCommerceStockAction()).toMatchObject({ ok: true });
    await loginAsTestUser({ role: "MANAGER" });
    await expect(pushWooCommerceStockAction()).rejects.toThrow(/autoris|permission/i);
    expect(state.stockUpdates).toHaveLength(0);
  });
});
