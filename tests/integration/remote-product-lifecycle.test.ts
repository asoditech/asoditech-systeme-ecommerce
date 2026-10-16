import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import { POST as shopifyWebhook } from "@/app/api/webhooks/shopify/route";
import { POST as wooWebhook } from "@/app/api/webhooks/woocommerce/route";
import { setShopifyRemoteDeletionModeAction, syncShopifyProductsAction } from "@/actions/shopify";
import { removeProductAction } from "@/actions/products";
import {
  changeRemoteListingAction,
  checkRemoteProductAction,
  reconcileRemoteListingAction,
  unlinkRemoteProductAction,
} from "@/actions/remote-product-links";
import { pendingRemoteMissingOf } from "@/lib/integrations/shared/remote-deletion";
import { remoteListingStateOf } from "@/lib/integrations/shared/remote-listing";
import { remoteDeletionModeOf } from "@/lib/integrations/woocommerce/store-settings";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { FAKE_ACCESS_TOKEN, emptyFakeShopifyStore, installFakeShopifyServer, type FakeProduct, type FakeShopifyState } from "../helpers/fake-shopify";
import {
  FAKE_CONSUMER_KEY,
  FAKE_CONSUMER_SECRET,
  FAKE_STORE_URL,
  emptyFakeStore,
  installFakeWooCommerceServer,
  wooErrorBody,
  type FakeStoreState,
} from "../helpers/fake-woocommerce";

/**
 * Remote product lifecycle for BOTH stores (DB-backed — needs the test
 * database; every store call is answered by the local fakes, no network):
 * - INBOUND Shopify parity with WooCommerce: products/delete re-read
 *   (`product(id:)` null = deleted), per-connection manual|auto mode,
 *   archive never delete, restore only an archive the store caused,
 *   variants removed → deactivated, tenant isolation;
 * - OUTBOUND « Retirer de la boutique » / « Remettre en vente »: soft status
 *   only, read-first, one attempt, « à vérifier », reconciliation, never a
 *   duplicate state-changing call.
 */

const SHOPIFY_SECRET = "remote-lifecycle-shopify-secret";
const WOO_SECRET = "remote-lifecycle-woo-secret";
const GID = "gid://shopify/Product/9100";

const sign = (body: string, secret: string) => createHmac("sha256", secret).update(body, "utf8").digest("base64");
let delivery = 0;
async function shopifyHook(topic: string, payload: unknown) {
  const body = JSON.stringify(payload);
  delivery++;
  return shopifyWebhook(
    new Request("https://app.example/api/webhooks/shopify", {
      method: "POST",
      body,
      headers: { "x-shopify-hmac-sha256": sign(body, SHOPIFY_SECRET), "x-shopify-topic": topic, "x-shopify-webhook-id": `sh-${delivery}` },
    })
  );
}
async function wooHook(topic: string, payload: unknown) {
  const body = JSON.stringify(payload);
  delivery++;
  return wooWebhook(
    new Request("http://localhost/api/webhooks/woocommerce", {
      method: "POST",
      body,
      headers: { "x-wc-webhook-signature": sign(body, WOO_SECRET), "x-wc-webhook-topic": topic, "x-wc-webhook-delivery-id": `wc-${delivery}` },
    })
  );
}

const auditCount = (action: string, entityId: string) => prisma.auditEvent.count({ where: { action, entityId } });

function fakeProduct(id: string, status: string, variants: { id: string; title: string; sku: string }[] = [{ id: `${id}-v`, title: "Default Title", sku: "SH-1" }]): FakeProduct {
  return {
    id,
    title: "Tee Shopify",
    handle: "tee",
    status,
    variants: variants.map((v) => ({ ...v, price: "100.00", inventoryItemId: `${v.id}-inv`, tracked: false, levels: [] })),
  };
}

async function history(productId: string) {
  const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt principal", isDefault: true } });
  const item = await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId, quantityOnHand: 5 } });
  await prisma.inventoryMovement.create({ data: { inventoryItemId: item.id, warehouseId: warehouse.id, type: "RECEPTION", quantity: 5, reason: "Réception" } });
  const customer = await prisma.customer.create({ data: { fullName: "Client", phone: "0600000009" } });
  await prisma.order.create({
    data: { customerId: customer.id, status: "LIVREE", subtotal: 100, total: 100, items: { create: [{ productId, nameSnapshot: "Tee", skuSnapshot: "SH-1", quantity: 1, unitPrice: 100, total: 100 }] } },
  });
}
const historyCounts = async () => ({
  movements: await prisma.inventoryMovement.count(),
  orderItems: await prisma.orderItem.count(),
  stock: await prisma.inventoryItem.count(),
});

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  vi.stubEnv("SHOPIFY_INTEGRATION_ENABLED", "true");
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Shopify — inbound remote deletion (parity with WooCommerce)", () => {
  let state: FakeShopifyState;
  beforeEach(() => {
    state = emptyFakeShopifyStore();
    installFakeShopifyServer(state);
  });
  const seedIntegration = (config: Record<string, unknown> = {}) =>
    prisma.integration.create({
      data: {
        provider: "SHOPIFY",
        status: "CONNECTE",
        config: { shopDomain: "https://boutique-test.myshopify.com", ...config },
        credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: FAKE_ACCESS_TOKEN, apiSecret: SHOPIFY_SECRET })),
      },
    });
  const seedImported = () => prisma.product.create({ data: { name: "Tee Shopify", sku: "SH-1", price: 100, status: "ACTIF", source: "SHOPIFY", externalId: GID } });

  it("mode defaults to manual; the choice is validated, audited and per company", async () => {
    const integration = await seedIntegration();
    expect(remoteDeletionModeOf(integration.config)).toBe("manual");
    await loginAsTestUser({ role: "ADMIN" });
    expect(await setShopifyRemoteDeletionModeAction("tout")).toMatchObject({ ok: false });
    expect(await setShopifyRemoteDeletionModeAction("auto")).toEqual({ ok: true, data: { mode: "auto" } });
    expect(remoteDeletionModeOf((await prisma.integration.findUniqueOrThrow({ where: { id: integration.id } })).config)).toBe("auto");
    await loginAsTestUser({ role: "MANAGER" });
    await expect(setShopifyRemoteDeletionModeAction("manual")).rejects.toThrow(/autoris|permission/i);
  });

  it("products/delete, manual (default): Shopify confirms (null) → archived (never deleted), flagged once, history intact", async () => {
    await seedIntegration();
    const product = await seedImported();
    await history(product.id);
    const before = await historyCounts();

    expect((await shopifyHook("products/delete", { id: 9100 })).status).toBe(200);
    expect((await shopifyHook("products/delete", { id: 9100 })).status).toBe(200); // a second delivery changes nothing
    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after).toMatchObject({ status: "ARCHIVE", source: "SHOPIFY", externalId: GID });
    expect(await auditCount("product.archived", product.id)).toBe(1);
    expect(await auditCount("product.remote_missing", product.id)).toBe(1);
    expect(await pendingRemoteMissingOf({ provider: "SHOPIFY", productId: product.id, externalId: GID })).toMatchObject({ check: "deleted" });
    expect(await historyCounts()).toEqual(before);
  });

  it("products/delete, auto: unlinked only on Shopify's confirmation; product + history stay", async () => {
    await seedIntegration({ remoteDeletionMode: "auto" });
    const product = await seedImported();
    await history(product.id);
    expect((await shopifyHook("products/delete", { id: 9100 })).status).toBe(200);
    expect(await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).toMatchObject({ source: "INTERNE", externalId: null, status: "ARCHIVE" });
    expect(await auditCount("product.remote_unlinked", product.id)).toBe(1);
    expect(await prisma.orderItem.count({ where: { productId: product.id } })).toBe(1);
  });

  it("products/delete but Shopify still has the product: nothing archived, nothing flagged", async () => {
    await seedIntegration({ remoteDeletionMode: "auto" });
    const product = await seedImported();
    state.products = [fakeProduct(GID, "ACTIVE")];
    expect((await shopifyHook("products/delete", { id: 9100 })).status).toBe(200);
    expect(await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).toMatchObject({ status: "ACTIF", source: "SHOPIFY" });
    expect(await auditCount("product.remote_missing", product.id)).toBe(0);
  });

  it.each(["throttled", "denied", "timeout", "server"] as const)(
    "products/delete with Shopify unverifiable (%s), even in auto: archived + flagged « unknown », never unlinked",
    async (failure) => {
      await seedIntegration({ remoteDeletionMode: "auto" });
      const product = await seedImported();
      // Persistent: the client's own retries (throttled / 5xx / network) fail too.
      state.statusReadFailure = failure;
      state.statusReadFailurePersistent = true;
      expect((await shopifyHook("products/delete", { id: 9100 })).status).toBe(200);
      expect(await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).toMatchObject({ status: "ARCHIVE", source: "SHOPIFY", externalId: GID });
      expect(await pendingRemoteMissingOf({ provider: "SHOPIFY", productId: product.id, externalId: GID })).toMatchObject({ check: "unknown" });
      expect(await auditCount("product.remote_unlinked", product.id)).toBe(0);
    }
  );

  it("a ONE-OFF throttled read that the client's retry gets through is a real answer (null = deleted), not « unknown »", async () => {
    await seedIntegration({ remoteDeletionMode: "auto" });
    const product = await seedImported();
    state.statusReadFailure = "throttled"; // next read only — the client retries
    expect((await shopifyHook("products/delete", { id: 9100 })).status).toBe(200);
    expect(await auditCount("product.remote_unlinked", product.id)).toBe(1);
  });

  it("a published ASODITECH product deleted on Shopify keeps its own status; only the link is flagged / unlinked", async () => {
    await seedIntegration();
    const published = await prisma.product.create({ data: { name: "Bougie", sku: "BOUGIE", price: 50, status: "ACTIF" } });
    await prisma.productPublication.create({ data: { productId: published.id, provider: "SHOPIFY", externalId: GID } });
    expect((await shopifyHook("products/delete", { id: 9100 })).status).toBe(200);
    expect(await prisma.product.findUniqueOrThrow({ where: { id: published.id } })).toMatchObject({ status: "ACTIF", source: "INTERNE" });
    await loginAsTestUser({ role: "ADMIN" });
    expect(await unlinkRemoteProductAction({ productId: published.id, provider: "SHOPIFY" })).toEqual({ ok: true, data: { unlinked: true } });
    expect(await prisma.productPublication.count({ where: { productId: published.id } })).toBe(0);
    expect(await unlinkRemoteProductAction({ productId: published.id, provider: "SHOPIFY" })).toMatchObject({ ok: false }); // already unlinked
    expect(await auditCount("product.remote_unlinked", published.id)).toBe(1);
  });

  it("« Vérifier sur la boutique » (Shopify): exists clears a flag; an unreachable shop changes nothing", async () => {
    await seedIntegration();
    const product = await seedImported();
    await loginAsTestUser({ role: "ADMIN" });
    state.statusReadFailure = "network";
    state.statusReadFailurePersistent = true; // unreachable for the client's retries too
    expect(await checkRemoteProductAction({ productId: product.id, provider: "SHOPIFY" })).toEqual({ ok: true, data: { check: "unknown", result: "unknown" } });
    expect(await pendingRemoteMissingOf({ provider: "SHOPIFY", productId: product.id, externalId: GID })).toBeNull();
    state.statusReadFailure = null;
    state.statusReadFailurePersistent = false;
    expect(await checkRemoteProductAction({ productId: product.id, provider: "SHOPIFY" })).toEqual({ ok: true, data: { check: "deleted", result: "flagged" } });
    state.products = [fakeProduct(GID, "ARCHIVED")]; // archived ≠ deleted
    expect(await checkRemoteProductAction({ productId: product.id, provider: "SHOPIFY" })).toEqual({ ok: true, data: { check: "exists", result: "exists" } });
    expect(await pendingRemoteMissingOf({ provider: "SHOPIFY", productId: product.id, externalId: GID })).toBeNull();
  });

  it("restore: an archive Shopify caused is lifted when Shopify serves the product ACTIVE again; a manual archive never is", async () => {
    await seedIntegration();
    await loginAsTestUser({ role: "ADMIN" });
    state.products = [fakeProduct(GID, "ACTIVE")];
    await syncShopifyProductsAction();
    const product = await prisma.product.findFirstOrThrow({ where: { source: "SHOPIFY", externalId: GID } });

    state.products[0].status = "ARCHIVED"; // archived on Shopify → deactivated here, recorded as the store's doing
    expect((await shopifyHook("products/update", { id: 9100 })).status).toBe(200);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).status).toBe("ARCHIVE");

    state.products[0].status = "ACTIVE";
    expect((await shopifyHook("products/update", { id: 9100 })).status).toBe(200);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).status).toBe("ACTIF");
    expect(await auditCount("product.restored", product.id)).toBe(1);

    // A user archives it in ASODITECH: Shopify ACTIVE never undoes that.
    const fd = new FormData();
    fd.set("productId", product.id);
    await history(product.id); // has history → archive, not delete
    await removeProductAction(fd);
    await syncShopifyProductsAction();
    expect((await shopifyHook("products/update", { id: 9100 })).status).toBe(200);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).status).toBe("ARCHIVE");
    expect(await auditCount("product.restored", product.id)).toBe(1);
  });

  it("variants removed on Shopify are deactivated, never deleted", async () => {
    await seedIntegration();
    await loginAsTestUser({ role: "ADMIN" });
    const variants = [
      { id: "gid://shopify/ProductVariant/1", title: "S", sku: "SH-S" },
      { id: "gid://shopify/ProductVariant/2", title: "M", sku: "SH-M" },
    ];
    state.products = [fakeProduct(GID, "ACTIVE", variants)];
    await syncShopifyProductsAction();
    state.products = [fakeProduct(GID, "ACTIVE", [variants[0]])];
    await syncShopifyProductsAction();
    const rows = await prisma.productVariation.findMany({ where: { externalId: { in: variants.map((v) => v.id) } }, orderBy: { sku: "asc" } });
    expect(rows.map((v) => [v.sku, v.isActive])).toEqual([
      ["SH-M", false],
      ["SH-S", true],
    ]);
  });

  it("tenant isolation: another company's product with the same gid is never touched", async () => {
    await seedIntegration();
    const TENANT_B = "tenant-b-remote-lifecycle";
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "B", slug: TENANT_B } });
    const other = await prismaBase.product.create({ data: { tenantId: TENANT_B, name: "B", sku: "B-1", price: 1, status: "ACTIF", source: "SHOPIFY", externalId: GID } });
    const mine = await seedImported();
    expect((await shopifyHook("products/delete", { id: 9100 })).status).toBe(200);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe("ARCHIVE");
    expect((await prismaBase.product.findUniqueOrThrow({ where: { id: other.id } })).status).toBe("ACTIF");
    expect(await prismaBase.auditEvent.count({ where: { entityId: other.id } })).toBe(0);
  });
});

describe("Shopify — outbound « Retirer de la boutique »", () => {
  let state: FakeShopifyState;
  beforeEach(async () => {
    state = emptyFakeShopifyStore();
    installFakeShopifyServer(state);
    await prisma.integration.create({
      data: {
        provider: "SHOPIFY",
        status: "CONNECTE",
        config: { shopDomain: "https://boutique-test.myshopify.com" },
        credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: FAKE_ACCESS_TOKEN, apiSecret: SHOPIFY_SECRET })),
      },
    });
  });
  const seedPublished = async () => {
    const product = await prisma.product.create({ data: { name: "Bougie", sku: "BOUGIE", price: 50, status: "ACTIF" } });
    await prisma.productPublication.create({ data: { productId: product.id, provider: "SHOPIFY", externalId: GID } });
    state.products = [fakeProduct(GID, "ACTIVE")];
    return product;
  };

  it("withdraw = ARCHIVED (never productDelete), republish = ACTIVE; local product untouched", async () => {
    const product = await seedPublished();
    await loginAsTestUser({ role: "ADMIN" });
    expect(await changeRemoteListingAction({ productId: product.id, provider: "SHOPIFY", op: "withdraw" })).toEqual({ ok: true, data: { outcome: "changed", listing: "withdrawn" } });
    expect(state.statusUpdates).toEqual([{ id: GID, status: "ARCHIVED" }]);
    expect(await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).toMatchObject({ status: "ACTIF", source: "INTERNE" });
    expect(await prisma.productPublication.count({ where: { productId: product.id } })).toBe(1);
    expect(await changeRemoteListingAction({ productId: product.id, provider: "SHOPIFY", op: "republish" })).toMatchObject({ ok: true, data: { listing: "live" } });
    expect(state.statusUpdates).toEqual([{ id: GID, status: "ARCHIVED" }, { id: GID, status: "ACTIVE" }]);
  });

  it.each([
    ["denied", /Accès refusé/],
    ["throttled", /limite temporairement/],
    ["userError", /a refusé la demande/],
  ] as const)("%s: visible error, nothing changed on Shopify", async (kind, message) => {
    const product = await seedPublished();
    await loginAsTestUser({ role: "ADMIN" });
    state.statusWriteFailure = { kind };
    expect(await changeRemoteListingAction({ productId: product.id, provider: "SHOPIFY", op: "withdraw" })).toMatchObject({ ok: false, error: expect.stringMatching(message) });
    expect(state.products[0].status).toBe("ACTIVE");
    expect((await remoteListingStateOf({ provider: "SHOPIFY", productId: product.id, externalId: GID })).phase).toBe("idle");
  });

  it("timeout after Shopify applied it: « à vérifier », then the retry sends nothing twice", async () => {
    const product = await seedPublished();
    await loginAsTestUser({ role: "ADMIN" });
    state.statusWriteFailure = { kind: "timeout", afterApply: true };
    expect(await changeRemoteListingAction({ productId: product.id, provider: "SHOPIFY", op: "withdraw" })).toMatchObject({ ok: false, error: expect.stringContaining("incertain") });
    expect((await remoteListingStateOf({ provider: "SHOPIFY", productId: product.id, externalId: GID })).phase).toBe("uncertain");
    expect(await changeRemoteListingAction({ productId: product.id, provider: "SHOPIFY", op: "withdraw" })).toEqual({ ok: true, data: { outcome: "already", listing: "withdrawn" } });
    expect(state.statusUpdates).toHaveLength(1);
  });

  it("network reset before Shopify applied it: reconciliation re-reads and records « not applied »", async () => {
    const product = await seedPublished();
    await loginAsTestUser({ role: "ADMIN" });
    state.statusWriteFailure = { kind: "network" };
    await changeRemoteListingAction({ productId: product.id, provider: "SHOPIFY", op: "withdraw" });
    expect(await reconcileRemoteListingAction({ productId: product.id, provider: "SHOPIFY" })).toEqual({ ok: true, data: { listing: "live", resolved: true } });
    expect((await remoteListingStateOf({ provider: "SHOPIFY", productId: product.id, externalId: GID })).phase).toBe("idle");
  });

  it("refused for a product created on Shopify (imported only), without integrations.manage, and for another company", async () => {
    const imported = await prisma.product.create({ data: { name: "Tee", sku: "SH-1", price: 100, status: "ACTIF", source: "SHOPIFY", externalId: GID } });
    await loginAsTestUser({ role: "ADMIN" });
    expect(await changeRemoteListingAction({ productId: imported.id, provider: "SHOPIFY", op: "withdraw" })).toMatchObject({ ok: false, error: expect.stringContaining("créé sur la boutique") });
    const published = await seedPublished();
    await loginAsTestUser({ role: "MANAGER" });
    expect(await changeRemoteListingAction({ productId: published.id, provider: "SHOPIFY", op: "withdraw" })).toMatchObject({ ok: false });
    const TENANT_B = "tenant-b-remote-listing";
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "B", slug: TENANT_B } });
    await loginAsTestUser({ role: "ADMIN", tenantId: TENANT_B });
    expect(await changeRemoteListingAction({ productId: published.id, provider: "SHOPIFY", op: "withdraw" })).toMatchObject({ ok: false });
    expect(state.statusUpdates ?? []).toHaveLength(0);
  });
});

describe("WooCommerce — outbound « Retirer de la boutique » and restore rules", () => {
  let state: FakeStoreState;
  beforeEach(async () => {
    state = emptyFakeStore();
    installFakeWooCommerceServer(state);
    await prisma.integration.create({
      data: {
        provider: "WOOCOMMERCE",
        status: "CONNECTE",
        config: { siteUrl: FAKE_STORE_URL },
        credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: FAKE_CONSUMER_KEY, apiSecret: FAKE_CONSUMER_SECRET, webhookSecret: WOO_SECRET })),
      },
    });
  });
  const wcProduct = (id: number, status: string) =>
    ({ id, name: "Bougie", slug: `b-${id}`, sku: `B-${id}`, status, type: "simple", regular_price: "50.00", manage_stock: false, stock_quantity: null, categories: [] }) as unknown as FakeStoreState["products"][number];
  const seedPublished = async () => {
    const product = await prisma.product.create({ data: { name: "Bougie", sku: "BOUGIE", price: 50, status: "ACTIF" } });
    await prisma.productPublication.create({ data: { productId: product.id, provider: "WOOCOMMERCE", externalId: "601" } });
    state.products = [wcProduct(601, "publish")];
    return product;
  };

  it("withdraw = draft (never DELETE / trash), republish = publish", async () => {
    const product = await seedPublished();
    await loginAsTestUser({ role: "ADMIN" });
    expect(await changeRemoteListingAction({ productId: product.id, provider: "WOOCOMMERCE", op: "withdraw" })).toEqual({ ok: true, data: { outcome: "changed", listing: "withdrawn" } });
    expect(await changeRemoteListingAction({ productId: product.id, provider: "WOOCOMMERCE", op: "republish" })).toMatchObject({ ok: true, data: { listing: "live" } });
    expect(state.statusUpdates).toEqual([{ id: 601, status: "draft" }, { id: 601, status: "publish" }]);
  });

  it.each([
    [{ status: 403, body: wooErrorBody("woocommerce_rest_cannot_edit", "Non.", 403) }, /Accès refusé/],
    [{ status: 429, body: "{}" }, /limite temporairement/],
  ] as const)("definite failure %#: visible, nothing changed", async (kind, message) => {
    const product = await seedPublished();
    await loginAsTestUser({ role: "ADMIN" });
    state.statusWriteFailure = { kind };
    expect(await changeRemoteListingAction({ productId: product.id, provider: "WOOCOMMERCE", op: "withdraw" })).toMatchObject({ ok: false, error: expect.stringMatching(message) });
    expect(state.products[0].status).toBe("publish");
  });

  it("unreadable 2xx after the store applied it: « à vérifier », retry sends nothing twice", async () => {
    const product = await seedPublished();
    await loginAsTestUser({ role: "ADMIN" });
    state.statusWriteFailure = { kind: "malformed", afterApply: true };
    expect(await changeRemoteListingAction({ productId: product.id, provider: "WOOCOMMERCE", op: "withdraw" })).toMatchObject({ ok: false });
    expect(await changeRemoteListingAction({ productId: product.id, provider: "WOOCOMMERCE", op: "withdraw" })).toMatchObject({ ok: true, data: { outcome: "already" } });
    expect(state.statusUpdates).toHaveLength(1);
  });

  it("already deleted on the store: nothing sent", async () => {
    const product = await seedPublished();
    await loginAsTestUser({ role: "ADMIN" });
    state.productGetErrors = { 601: { status: 404, body: wooErrorBody("woocommerce_rest_product_invalid_id", "ID non valide.", 404) } };
    expect(await changeRemoteListingAction({ productId: product.id, provider: "WOOCOMMERCE", op: "withdraw" })).toMatchObject({ ok: false, error: expect.stringContaining("n'existe plus") });
    expect(state.statusUpdates ?? []).toHaveLength(0);
  });

  it("product.restored never undoes a manual archive", async () => {
    const product = await prisma.product.create({ data: { name: "Tee", sku: "TEE-1", price: 100, status: "ACTIF", source: "WOOCOMMERCE", externalId: "701" } });
    state.products = [{ ...wcProduct(701, "publish"), sku: "TEE-1" }];
    await loginAsTestUser({ role: "ADMIN" });
    await history(product.id);
    const fd = new FormData();
    fd.set("productId", product.id);
    await removeProductAction(fd); // user archive
    expect((await wooHook("product.restored", { id: 701 })).status).toBe(200);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).status).toBe("ARCHIVE");
    expect(await auditCount("product.restored", product.id)).toBe(0);
  });
});
