import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import { syncWooCommerceProductsAction } from "@/actions/woocommerce";
import { syncShopifyProductsAction } from "@/actions/shopify";
import { POST as wooWebhook } from "@/app/api/webhooks/woocommerce/route";
import { prepareProductExport } from "@/lib/catalog/export/service";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import {
  FAKE_STORE_URL,
  FAKE_CONSUMER_KEY,
  FAKE_CONSUMER_SECRET,
  emptyFakeStore,
  installFakeWooCommerceServer,
  type FakeStoreState,
} from "../helpers/fake-woocommerce";
import { FAKE_SHOP_DOMAIN, FAKE_ACCESS_TOKEN, emptyFakeShopifyStore, installFakeShopifyServer, type FakeShopifyState } from "../helpers/fake-shopify";

/**
 * Store → ASODITECH identity reconciliation — docs/adr/0055. An ASODITECH
 * product that reached a connected store by CSV import (or « Publier ») must
 * come back as THE SAME product, never a `-wc-<id>` / `-shop-<id>` duplicate.
 */

const WEBHOOK_SECRET = "identity-webhook-secret";

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function wooStore(): Promise<FakeStoreState> {
  const state = emptyFakeStore();
  installFakeWooCommerceServer(state);
  await prisma.integration.create({
    data: {
      provider: "WOOCOMMERCE",
      status: "CONNECTE",
      config: { siteUrl: FAKE_STORE_URL },
      credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: FAKE_CONSUMER_KEY, apiSecret: FAKE_CONSUMER_SECRET, webhookSecret: WEBHOOK_SECRET })),
    },
  });
  return state;
}
const wooProduct = (o: { id: number; sku: string; name?: string; type?: string; variations?: { id: number; sku: string; attrs: Record<string, string>; price: string }[] }) => ({
  id: o.id,
  name: o.name ?? `Produit ${o.sku}`,
  slug: `p-${o.id}`,
  sku: o.sku,
  status: "publish",
  type: o.type ?? "simple",
  regular_price: "100.00",
  manage_stock: true,
  stock_quantity: 0,
  categories: [],
  ...(o.variations
    ? {
        variations: o.variations.map((v) => v.id),
        variationList: o.variations.map((v) => ({
          id: v.id,
          sku: v.sku,
          regular_price: v.price,
          manage_stock: false,
          stock_quantity: null,
          attributes: Object.entries(v.attrs).map(([name, option]) => ({ name, option })),
        })),
      }
    : {}),
});
const sign = (body: string) => createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("base64");
const hook = (topic: string, deliveryId: string, payload: object) => {
  const body = JSON.stringify(payload);
  return wooWebhook(
    new Request("https://app.example/api/webhooks/woocommerce", {
      method: "POST",
      headers: { "content-type": "application/json", "x-wc-webhook-signature": sign(body), "x-wc-webhook-topic": topic, "x-wc-webhook-delivery-id": deliveryId },
      body,
    })
  );
};

async function internal(sku: string, opts: { variations?: { sku: string; attrs: Record<string, string> }[]; stock?: number } = {}) {
  const wh = (await prisma.warehouse.findFirst({ where: { isDefault: true } })) ?? (await prisma.warehouse.create({ data: { name: "Entrepôt", isDefault: true } }));
  const p = await prisma.product.create({
    data: {
      name: `ASODITECH ${sku}`,
      sku,
      price: 100,
      status: "ACTIF",
      variations: opts.variations ? { create: opts.variations.map((v) => ({ sku: v.sku, attributes: v.attrs, price: 100 })) } : undefined,
    },
    include: { variations: true },
  });
  if (opts.stock !== undefined) await prisma.inventoryItem.create({ data: { warehouseId: wh.id, productId: p.id, quantityOnHand: opts.stock } });
  return p;
}

describe("WooCommerce", () => {
  it("an exported simple product is ADOPTED by SKU — no duplicate, ASODITECH stock untouched, idempotent", async () => {
    const state = await wooStore();
    await loginAsTestUser({ role: "ADMIN" });
    const mine = await internal("EXP-1", { stock: 7 });
    state.products.push(wooProduct({ id: 9001, sku: "EXP-1" }));

    const r = await syncWooCommerceProductsAction();
    expect(r.ok).toBe(true);
    const all = await prisma.product.findMany({ where: { sku: { startsWith: "EXP-1" } } });
    expect(all.map((p) => [p.id, p.sku, p.source, p.externalId])).toEqual([[mine.id, "EXP-1", "WOOCOMMERCE", "9001"]]);
    expect(await prisma.productPublication.findMany({ where: { productId: mine.id }, select: { provider: true, externalId: true } })).toEqual([{ provider: "WOOCOMMERCE", externalId: "9001" }]);
    expect((await prisma.inventoryItem.findFirstOrThrow({ where: { productId: mine.id } })).quantityOnHand).toBe(7);

    await syncWooCommerceProductsAction();
    expect(await prisma.product.count({ where: { sku: { startsWith: "EXP-1" } } })).toBe(1);
  });

  it("a variable product: variations adopted by SKU WITHIN the parent only; an unknown store variation is created; nothing merged across products", async () => {
    const state = await wooStore();
    await loginAsTestUser({ role: "ADMIN" });
    const tee = await internal("TEE", { variations: [{ sku: "TEE-S", attrs: { Taille: "S" } }, { sku: "TEE-M", attrs: { Taille: "M" } }] });
    const other = await internal("OTHER", { variations: [{ sku: "TEE-L", attrs: { Taille: "L" } }] });
    state.products.push(
      wooProduct({
        id: 9100,
        sku: "TEE",
        type: "variable",
        variations: [
          { id: 9101, sku: "TEE-S", attrs: { Taille: "S" }, price: "100.00" },
          { id: 9102, sku: "TEE-M", attrs: { Taille: "M" }, price: "100.00" },
          { id: 9103, sku: "TEE-L", attrs: { Taille: "L" }, price: "100.00" },
        ],
      })
    );
    await syncWooCommerceProductsAction();

    const teeVars = await prisma.productVariation.findMany({ where: { productId: tee.id }, orderBy: { sku: "asc" } });
    expect(teeVars.filter((v) => v.sku === "TEE-S" || v.sku === "TEE-M").map((v) => [v.id, v.source, v.externalId])).toEqual([
      [tee.variations.find((v) => v.sku === "TEE-M")!.id, "WOOCOMMERCE", "9102"],
      [tee.variations.find((v) => v.sku === "TEE-S")!.id, "WOOCOMMERCE", "9101"],
    ]);
    // TEE-L belongs to ANOTHER product: never adopted — a new variation is created under TEE (existing suffix rule)
    const otherVar = await prisma.productVariation.findFirstOrThrow({ where: { productId: other.id } });
    expect([otherVar.sku, otherVar.source, otherVar.externalId]).toEqual(["TEE-L", "INTERNE", null]);
    expect(teeVars.find((v) => v.externalId === "9103")?.sku).toBe("TEE-L-wc-9103");
    expect((await prisma.product.findUniqueOrThrow({ where: { id: tee.id } })).externalId).toBe("9100");
    expect(await prisma.product.count()).toBe(2);
  });

  it("an existing publication identity is reused even when the store SKU changed", async () => {
    const state = await wooStore();
    await loginAsTestUser({ role: "ADMIN" });
    const published = await internal("PUB-1");
    await prisma.productPublication.create({ data: { productId: published.id, provider: "WOOCOMMERCE", externalId: "9200" } });
    state.products.push(wooProduct({ id: 9200, sku: "RENAMED-IN-STORE" }));
    await syncWooCommerceProductsAction();
    expect(await prisma.product.count()).toBe(1);
    const p = await prisma.product.findUniqueOrThrow({ where: { id: published.id } });
    expect([p.source, p.externalId, p.sku]).toEqual(["WOOCOMMERCE", "9200", "RENAMED-IN-STORE"]); // store-owned field after linking
  });

  it("an unrelated store product, or a shape mismatch, still creates a new product (existing behaviour)", async () => {
    const state = await wooStore();
    await loginAsTestUser({ role: "ADMIN" });
    const variableHere = await internal("SHAPE", { variations: [{ sku: "SHAPE-S", attrs: { Taille: "S" } }] });
    state.products.push(wooProduct({ id: 9300, sku: "NEW-1" }), wooProduct({ id: 9301, sku: "SHAPE" }));
    await syncWooCommerceProductsAction();
    expect((await prisma.product.findFirstOrThrow({ where: { externalId: "9300" } })).sku).toBe("NEW-1");
    expect((await prisma.product.findFirstOrThrow({ where: { externalId: "9301" } })).sku).toBe("SHAPE-wc-9301");
    expect((await prisma.product.findUniqueOrThrow({ where: { id: variableHere.id } })).source).toBe("INTERNE");
  });

  it("the same SKU in ANOTHER tenant is never a candidate", async () => {
    await prismaBase.tenant.create({ data: { id: "tenant-b-0055", name: "B", slug: "tenant-b-0055" } });
    const foreign = await prismaBase.product.create({ data: { tenantId: "tenant-b-0055", name: "Produit de B", sku: "SHARED-1", price: 1 } });
    const state = await wooStore();
    await loginAsTestUser({ role: "ADMIN" });
    state.products.push(wooProduct({ id: 9400, sku: "SHARED-1" }));
    await syncWooCommerceProductsAction();
    const mine = await prisma.product.findFirstOrThrow({ where: { externalId: "9400" } });
    expect(mine.id).not.toBe(foreign.id);
    expect(mine.sku).toBe("SHARED-1");
    const b = await prismaBase.product.findUniqueOrThrow({ where: { id: foreign.id } });
    expect([b.source, b.externalId]).toEqual(["INTERNE", null]);
  });

  it("product.created webhook adopts; replays and product.updated stay idempotent; orders then map to the SAME product", async () => {
    await wooStore();
    const mine = await internal("HOOK-1", { stock: 3 });
    const payload = wooProduct({ id: 9500, sku: "HOOK-1" });
    expect((await hook("product.created", "d-1", payload)).status).toBe(200);
    expect((await hook("product.created", "d-1", payload)).status).toBe(200); // exact replay
    expect((await hook("product.updated", "d-2", { ...payload, name: "Renommé" })).status).toBe(200);
    const all = await prisma.product.findMany({ where: { sku: { startsWith: "HOOK-1" } } });
    expect(all.map((p) => [p.id, p.externalId, p.name])).toEqual([[mine.id, "9500", "Renommé"]]);
    expect(await prisma.productPublication.count({ where: { productId: mine.id } })).toBe(1);

    const order = {
      id: 7701,
      number: "7701",
      status: "pending",
      currency: "MAD",
      date_created: "2026-01-20T10:00:00",
      date_paid: null,
      customer_id: 0,
      total: "100.00",
      total_tax: "0.00",
      shipping_total: "0.00",
      discount_total: "0.00",
      payment_method: "cod",
      billing: { first_name: "A", last_name: "B", email: "a@b.test", city: "Casablanca", country: "MA", address_1: "1 rue" },
      shipping: {},
      line_items: [{ id: 1, name: "Renommé", product_id: 9500, sku: "HOOK-1", quantity: 1, price: "100.00", subtotal: "100.00", total: "100.00" }],
      refunds: [],
    };
    expect((await hook("order.created", "d-3", order)).status).toBe(200);
    const line = await prisma.orderItem.findFirstOrThrow({ where: { order: { externalId: "7701" } } });
    expect(line.productId).toBe(mine.id);
  });
});

/** Minimal RFC 4180 reader (quoted cells, doubled quotes) — enough to read back our own export. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

describe("round trip: ASODITECH product → WooCommerce CSV → store → sync back", () => {
  it("the product exported by CSV comes back as the SAME product, variations included, no duplicate", async () => {
    const state = await wooStore();
    await loginAsTestUser({ role: "ADMIN" });
    const mine = await internal("RT-TEE", { variations: [{ sku: "RT-TEE-S", attrs: { Taille: "S" } }, { sku: "RT-TEE-M", attrs: { Taille: "M" } }] });

    // 1. the real export, as downloaded
    const exported = await prepareProductExport("woocommerce", [mine.id]);
    expect(exported.csv).not.toBeNull();
    const lines = parseCsv(exported.csv!);
    const header = lines[0];
    const col = (row: string[], name: string) => row[header.indexOf(name)];
    const parent = lines.find((r) => col(r, "Type") === "variable")!;
    const variations = lines.filter((r) => col(r, "Type") === "variation");

    // 2. what WooCommerce's importer creates from those rows (new store ids)
    state.products.push(
      wooProduct({
        id: 9900,
        sku: col(parent, "SKU"),
        type: "variable",
        variations: variations.map((v, i) => ({ id: 9901 + i, sku: col(v, "SKU"), attrs: { [col(v, "Attribute 1 name")]: col(v, "Attribute 1 value(s)") }, price: col(v, "Regular price") })),
      })
    );

    // 3. sync back
    await syncWooCommerceProductsAction();
    expect(await prisma.product.count()).toBe(1);
    const p = await prisma.product.findUniqueOrThrow({ where: { id: mine.id }, include: { variations: { orderBy: { sku: "asc" } } } });
    expect([p.source, p.externalId]).toEqual(["WOOCOMMERCE", "9900"]);
    // each ORIGINAL ASODITECH variation now carries the store id assigned to its CSV row
    const storeIdOf = (sku: string) => String(9901 + variations.findIndex((v) => col(v, "SKU") === sku));
    expect(p.variations.map((v) => [v.id, v.sku, v.externalId])).toEqual(
      ["RT-TEE-M", "RT-TEE-S"].map((sku) => [mine.variations.find((v) => v.sku === sku)!.id, sku, storeIdOf(sku)])
    );
    expect(await prisma.productVariation.count()).toBe(2);
  });
});

describe("Shopify", () => {
  async function shopifyStore(): Promise<FakeShopifyState> {
    vi.stubEnv("SHOPIFY_INTEGRATION_ENABLED", "true");
    const state = emptyFakeShopifyStore();
    installFakeShopifyServer(state);
    await prisma.integration.create({
      data: {
        provider: "SHOPIFY",
        status: "CONNECTE",
        config: { shopDomain: FAKE_SHOP_DOMAIN },
        credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: FAKE_ACCESS_TOKEN })),
      },
    });
    return state;
  }
  const variant = (id: number, title: string, sku: string | null) => ({ id: `gid://shopify/ProductVariant/${id}`, title, sku, price: "100.00", inventoryItemId: `gid://shopify/InventoryItem/${id}`, tracked: false, levels: [] });

  it("simple product by SKU, variable product by its variants' SKUs; structured attributes are not flattened", async () => {
    const state = await shopifyStore();
    await loginAsTestUser({ role: "ADMIN" });
    const mug = await internal("MUG-1");
    const tee = await internal("TEE-SH", { variations: [{ sku: "TS-S-N", attrs: { Taille: "S", Couleur: "Noir" } }, { sku: "TS-M-N", attrs: { Taille: "M", Couleur: "Noir" } }] });
    state.products = [
      { id: "gid://shopify/Product/1", title: "Mug", handle: "mug", status: "ACTIVE", variants: [variant(11, "Default Title", "MUG-1")] },
      { id: "gid://shopify/Product/2", title: "T-Shirt", handle: "t-shirt", status: "ACTIVE", variants: [variant(21, "S / Noir", "TS-S-N"), variant(22, "M / Noir", "TS-M-N")] },
    ];
    const r = await syncShopifyProductsAction();
    expect(r.ok).toBe(true);
    expect(await prisma.product.count()).toBe(2);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: mug.id } })).externalId).toBe("gid://shopify/Product/1");
    expect((await prisma.product.findUniqueOrThrow({ where: { id: tee.id } })).externalId).toBe("gid://shopify/Product/2");
    const vars = await prisma.productVariation.findMany({ where: { productId: tee.id }, orderBy: { sku: "asc" } });
    expect(vars.map((v) => [v.sku, v.source, v.externalId, v.attributes])).toEqual([
      ["TS-M-N", "SHOPIFY", "gid://shopify/ProductVariant/22", { Taille: "M", Couleur: "Noir" }],
      ["TS-S-N", "SHOPIFY", "gid://shopify/ProductVariant/21", { Taille: "S", Couleur: "Noir" }],
    ]);
    await syncShopifyProductsAction();
    expect(await prisma.product.count()).toBe(2);
    expect(await prisma.productVariation.count()).toBe(2);
  });

  it("variants whose SKUs belong to TWO different ASODITECH products are never stitched together", async () => {
    const state = await shopifyStore();
    await loginAsTestUser({ role: "ADMIN" });
    const a = await internal("A", { variations: [{ sku: "X-1", attrs: { Taille: "S" } }] });
    const b = await internal("B", { variations: [{ sku: "X-2", attrs: { Taille: "M" } }] });
    state.products = [{ id: "gid://shopify/Product/3", title: "Mix", handle: "mix", status: "ACTIVE", variants: [variant(31, "S", "X-1"), variant(32, "M", "X-2")] }];
    await syncShopifyProductsAction();
    for (const p of [a, b]) expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).source).toBe("INTERNE");
    expect(await prisma.product.count({ where: { externalId: "gid://shopify/Product/3" } })).toBe(1);
  });
});
