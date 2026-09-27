import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import { publishProductAction } from "@/actions/product-publishing";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import {
  FAKE_STORE_URL,
  FAKE_CONSUMER_KEY,
  FAKE_CONSUMER_SECRET,
  emptyFakeStore,
  installFakeWooCommerceServer,
} from "../helpers/fake-woocommerce";
import { FAKE_SHOP_DOMAIN, FAKE_ACCESS_TOKEN, emptyFakeShopifyStore, installFakeShopifyServer } from "../helpers/fake-shopify";

async function seedProduct(overrides: Partial<{ price: number; status: "ACTIF" | "BROUILLON" }> = {}) {
  return prisma.product.create({
    data: {
      name: "T-Shirt Publishable",
      sku: `PUB-${Math.random()}`,
      price: overrides.price ?? 150,
      status: overrides.status ?? "ACTIF",
    },
  });
}

async function connectWooCommerce() {
  const state = emptyFakeStore();
  installFakeWooCommerceServer(state);
  await prisma.integration.create({
    data: {
      provider: "WOOCOMMERCE",
      status: "CONNECTE",
      config: { siteUrl: FAKE_STORE_URL },
      credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: FAKE_CONSUMER_KEY, apiSecret: FAKE_CONSUMER_SECRET })),
    },
  });
  return state;
}

async function connectShopify() {
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

describe("publishProductAction — WooCommerce (Batch 13)", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
    vi.unstubAllGlobals();
  });

  it("publishes a simple product: correct payload, persists external id, no inventory side effect", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const product = await seedProduct();
    const state = await connectWooCommerce();

    const result = await publishProductAction({ productId: product.id, provider: "WOOCOMMERCE" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.externalId).toBe("80001");

    expect(state.productCreates).toHaveLength(1);
    expect(state.productCreates[0]).toMatchObject({ name: "T-Shirt Publishable", sku: product.sku, type: "simple", status: "publish" });

    const publication = await prisma.productPublication.findUniqueOrThrow({
      where: { tenantId_productId_provider: { tenantId: product.tenantId, productId: product.id, provider: "WOOCOMMERCE" } },
    });
    expect(publication.externalId).toBe("80001");

    // Publishing must never touch inventory (docs/adr/0036) — no
    // InventoryItem/InventoryMovement ever existed for this product.
    expect(await prisma.inventoryItem.count({ where: { productId: product.id } })).toBe(0);
    expect(await prisma.inventoryMovement.count()).toBe(0);
  });

  it("publishes a variable product as type=variable with each active variation created separately, inactive ones excluded", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const product = await seedProduct();
    await prisma.productVariation.create({
      data: { productId: product.id, sku: `${product.sku}-S`, attributes: { Taille: "S" }, price: 100, isActive: true },
    });
    await prisma.productVariation.create({
      data: { productId: product.id, sku: `${product.sku}-M`, attributes: { Taille: "M" }, isActive: true },
    });
    await prisma.productVariation.create({
      data: { productId: product.id, sku: `${product.sku}-L`, attributes: { Taille: "L" }, isActive: false },
    });
    const state = await connectWooCommerce();

    const result = await publishProductAction({ productId: product.id, provider: "WOOCOMMERCE" });
    expect(result.ok).toBe(true);

    expect(state.productCreates[0]).toMatchObject({ type: "variable" });
    expect(state.productCreates[0]).not.toHaveProperty("regular_price");
    expect(state.variationCreates).toHaveLength(2); // S and M only — L is inactive
    expect(state.variationCreates.map((v) => v.body.sku).sort()).toEqual([`${product.sku}-M`, `${product.sku}-S`].sort());
  });

  it("rejects re-publishing an already-published product (duplicate protection) without calling the provider again", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const product = await seedProduct();
    const state = await connectWooCommerce();
    await publishProductAction({ productId: product.id, provider: "WOOCOMMERCE" });
    expect(state.productCreates).toHaveLength(1);

    const second = await publishProductAction({ productId: product.id, provider: "WOOCOMMERCE" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/déjà publié/i);
    expect(state.productCreates).toHaveLength(1); // never called twice
  });

  it("rejects a BROUILLON product and a zero-price product (eligibility)", async () => {
    await loginAsTestUser({ role: "OWNER" });
    await connectWooCommerce();
    const draft = await seedProduct({ status: "BROUILLON" });
    const free = await seedProduct({ price: 0 });

    const draftResult = await publishProductAction({ productId: draft.id, provider: "WOOCOMMERCE" });
    expect(draftResult.ok).toBe(false);
    if (!draftResult.ok) expect(draftResult.error).toMatch(/Actif/);

    const freeResult = await publishProductAction({ productId: free.id, provider: "WOOCOMMERCE" });
    expect(freeResult.ok).toBe(false);
    if (!freeResult.ok) expect(freeResult.error).toMatch(/Prix de vente/);
  });

  it("refuses to publish when WooCommerce is not connected", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const product = await seedProduct();

    const result = await publishProductAction({ productId: product.id, provider: "WOOCOMMERCE" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/connect/i);
  });

  it("refuses to publish when the integration is only CONFIGURE, not CONNECTE", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const product = await seedProduct();
    await prisma.integration.create({
      data: {
        provider: "WOOCOMMERCE",
        status: "CONFIGURE",
        config: { siteUrl: FAKE_STORE_URL },
        credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: FAKE_CONSUMER_KEY, apiSecret: FAKE_CONSUMER_SECRET })),
      },
    });

    const result = await publishProductAction({ productId: product.id, provider: "WOOCOMMERCE" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/pas connecté/i);
  });

  it("maps a provider rejection to a safe user-facing error, never a raw stack trace", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const product = await seedProduct();
    await connectWooCommerce();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "woocommerce_rest_cannot_create" }), { status: 401 })));

    const result = await publishProductAction({ productId: product.id, provider: "WOOCOMMERCE" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Publication impossible/);
      expect(result.error).not.toMatch(/at Object|node_modules|TypeError/);
    }
  });

  it("rejects a caller without products.edit", async () => {
    await loginAsTestUser({ role: "SUPPORT" });
    const product = await seedProduct();
    await expect(publishProductAction({ productId: product.id, provider: "WOOCOMMERCE" })).rejects.toThrow(/non autorisé/i);
  });

  it("rejects a caller with products.edit but without integrations.manage", async () => {
    await loginAsTestUser({ role: "MANAGER" }); // MANAGER: products.edit yes, integrations.manage no
    const product = await seedProduct();
    await connectWooCommerce();
    const result = await publishProductAction({ productId: product.id, provider: "WOOCOMMERCE" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/permission/i);
  });

  it("tenant isolation: cannot publish using another tenant's connected integration", async () => {
    await loginAsTestUser({ role: "OWNER" }); // default tenant
    const product = await seedProduct();
    // No WooCommerce integration for THIS tenant — even though the fake
    // server is installed, `loadWooCommerceClient` only ever reads the
    // active tenant's own row (Prisma tenant-scoping extension, docs/adr/0024).
    installFakeWooCommerceServer(emptyFakeStore());
    const TENANT_B = "tenant-b-publishing";
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    await prismaBase.integration.create({
      data: {
        tenantId: TENANT_B,
        provider: "WOOCOMMERCE",
        status: "CONNECTE",
        config: { siteUrl: FAKE_STORE_URL },
        credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: FAKE_CONSUMER_KEY, apiSecret: FAKE_CONSUMER_SECRET })),
      },
    });

    const result = await publishProductAction({ productId: product.id, provider: "WOOCOMMERCE" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/connect/i);

    await prismaBase.tenant.delete({ where: { id: TENANT_B } }).catch(() => {});
  });

  it("a productId belonging to another tenant is simply not found (never leaks existence)", async () => {
    await loginAsTestUser({ role: "OWNER" }); // default tenant
    const TENANT_B = "tenant-b-publishing-product";
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    const foreignProduct = await prismaBase.product.create({
      data: { tenantId: TENANT_B, name: "Produit Tenant B", sku: `PUB-B-${Math.random()}`, price: 100, status: "ACTIF" },
    });
    await connectWooCommerce();

    const result = await publishProductAction({ productId: foreignProduct.id, provider: "WOOCOMMERCE" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/introuvable/i);

    await prismaBase.product.delete({ where: { id: foreignProduct.id } }).catch(() => {});
    await prismaBase.tenant.delete({ where: { id: TENANT_B } }).catch(() => {});
  });
});

describe("publishProductAction — Shopify (Batch 13)", () => {
  const originalFlag = process.env.SHOPIFY_INTEGRATION_ENABLED;

  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
    process.env.SHOPIFY_INTEGRATION_ENABLED = "true";
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
    vi.unstubAllGlobals();
    process.env.SHOPIFY_INTEGRATION_ENABLED = originalFlag;
  });

  it("publishes a simple product: creates the product then sets price/sku on the default variant, persists external id (gid)", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const product = await seedProduct();
    const state = await connectShopify();

    const result = await publishProductAction({ productId: product.id, provider: "SHOPIFY" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.externalId).toMatch(/^gid:\/\/shopify\/Product\//);

    expect(state.productCreates).toHaveLength(1);
    expect(state.productCreates[0]).toMatchObject({ title: "T-Shirt Publishable", status: "ACTIVE" });
    expect(state.variantUpdates).toHaveLength(1);
    // `(product.salePrice ?? product.price).toString()` on a Decimal(150)
    // — no forced 2-decimal formatting, unlike WooCommerce's `money()`.
    expect(state.variantUpdates[0]).toMatchObject({ price: "150" });

    const publication = await prisma.productPublication.findUniqueOrThrow({
      where: { tenantId_productId_provider: { tenantId: product.tenantId, productId: product.id, provider: "SHOPIFY" } },
    });
    expect(publication.externalId).toBe(result.data.externalId);
  });

  it("refuses a variable product for Shopify (not yet supported) without calling the provider", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const product = await seedProduct();
    await prisma.productVariation.create({ data: { productId: product.id, sku: `${product.sku}-A`, attributes: { Taille: "S" } } });
    await prisma.productVariation.create({ data: { productId: product.id, sku: `${product.sku}-B`, attributes: { Taille: "M" } } });
    const state = await connectShopify();

    const result = await publishProductAction({ productId: product.id, provider: "SHOPIFY" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/variantes/i);
    expect(state.productCreates).toHaveLength(0);
  });

  it("is disabled by default (Shopify kill switch, client feedback #10) — refuses even with a connected integration", async () => {
    process.env.SHOPIFY_INTEGRATION_ENABLED = "false";
    await loginAsTestUser({ role: "OWNER" });
    const product = await seedProduct();
    await connectShopify();

    const result = await publishProductAction({ productId: product.id, provider: "SHOPIFY" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/pas encore disponible/i);
  });
});
