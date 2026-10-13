import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import { POST as wooWebhook } from "@/app/api/webhooks/woocommerce/route";
import { setWooCommerceRemoteDeletionModeAction, syncWooCommerceProductsAction } from "@/actions/woocommerce";
import { checkWooCommerceRemoteProductAction, unlinkWooCommerceProductAction } from "@/actions/remote-product-links";
import { pendingRemoteMissing } from "@/lib/integrations/woocommerce/remote-deletion";
import { remoteDeletionModeOf } from "@/lib/integrations/woocommerce/store-settings";
import { exportFilterWhere } from "@/lib/catalog/export/load";
import { resetDb } from "../helpers/db";
import { createTestUser, loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
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
 * Per-company « Que faire lorsqu'un produit est supprimé de la boutique ? »
 * (src/lib/integrations/woocommerce/remote-deletion.ts): manual by default,
 * automatic unlinking only on a deletion the store itself confirms, never on
 * an error; the local product, its stock and history always stay.
 * Every store call is answered by the local fake server — no network.
 */

const WEBHOOK_SECRET = "remote-deletion-secret";
const DELETED = { status: 404, body: wooErrorBody("woocommerce_rest_product_invalid_id", "ID non valide.", 404) };

let state: FakeStoreState;

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  state = emptyFakeStore();
  installFakeWooCommerceServer(state);
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
      credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: FAKE_CONSUMER_KEY, apiSecret: FAKE_CONSUMER_SECRET, webhookSecret: WEBHOOK_SECRET })),
    },
  });
}

/** An imported (variable) product with stock, a movement and a sold line, plus a published ASODITECH product. */
async function seedCatalog() {
  const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt principal", isDefault: true } });
  const imported = await prisma.product.create({
    data: { name: "Tee importé", sku: "TEE-WC", price: 100, status: "ACTIF", source: "WOOCOMMERCE", externalId: "501" },
  });
  const variation = await prisma.productVariation.create({
    data: { productId: imported.id, sku: "TEE-WC-M", attributes: { Taille: "M" }, source: "WOOCOMMERCE", externalId: "5011" },
  });
  const item = await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, variationId: variation.id, quantityOnHand: 7, quantityReserved: 2 } });
  await prisma.inventoryMovement.create({ data: { inventoryItemId: item.id, warehouseId: warehouse.id, type: "RECEPTION", quantity: 7, reason: "Réception" } });
  const customer = await prisma.customer.create({ data: { fullName: "Client Test", phone: "0600000001" } });
  const order = await prisma.order.create({
    data: {
      customerId: customer.id,
      status: "LIVREE",
      subtotal: 100,
      total: 100,
      items: { create: [{ productId: imported.id, variationId: variation.id, nameSnapshot: "Tee importé", skuSnapshot: "TEE-WC-M", quantity: 1, unitPrice: 100, total: 100 }] },
    },
  });
  const published = await prisma.product.create({ data: { name: "Bougie maison", sku: "BOUGIE-1", price: 50, status: "ACTIF" } });
  await prisma.productPublication.create({ data: { productId: published.id, provider: "WOOCOMMERCE", externalId: "601" } });
  return { warehouse, imported, variation, item, order, published };
}

const sign = (body: string, secret = WEBHOOK_SECRET) => createHmac("sha256", secret).update(body, "utf8").digest("base64");
let delivery = 0;
async function deletedWebhook(id: number) {
  const body = JSON.stringify({ id });
  delivery++;
  const res = await wooWebhook(
    new Request("http://localhost/api/webhooks/woocommerce", {
      method: "POST",
      body,
      headers: { "x-wc-webhook-signature": sign(body), "x-wc-webhook-topic": "product.deleted", "x-wc-webhook-delivery-id": `del-${delivery}` },
    })
  );
  expect(res.status).toBe(200);
}

async function restoredWebhook(id: number) {
  const body = JSON.stringify({ id });
  delivery++;
  const res = await wooWebhook(
    new Request("http://localhost/api/webhooks/woocommerce", {
      method: "POST",
      body,
      headers: { "x-wc-webhook-signature": sign(body), "x-wc-webhook-topic": "product.restored", "x-wc-webhook-delivery-id": `res-${delivery}` },
    })
  );
  expect(res.status).toBe(200);
}

async function stockSnapshot() {
  return {
    items: await prisma.inventoryItem.findMany({ select: { id: true, quantityOnHand: true, quantityReserved: true, variationId: true, productId: true }, orderBy: { id: "asc" } }),
    movements: await prisma.inventoryMovement.count(),
    orderItems: await prisma.orderItem.findMany({ select: { productId: true, variationId: true } }),
  };
}

const auditCount = (action: string, entityId: string) => prisma.auditEvent.count({ where: { action, entityId } });

describe("setting: per company, manual by default", () => {
  it("missing or invalid value → manual (never silently automatic)", () => {
    expect(remoteDeletionModeOf(null)).toBe("manual");
    expect(remoteDeletionModeOf({})).toBe("manual");
    expect(remoteDeletionModeOf({ remoteDeletionMode: "AUTO" })).toBe("manual");
    expect(remoteDeletionModeOf({ remoteDeletionMode: true })).toBe("manual");
    expect(remoteDeletionModeOf({ remoteDeletionMode: "auto" })).toBe("auto");
  });

  it("is saved on this company's connection only, validated server-side and audited", async () => {
    const TENANT_B = "tenant-b-remote-del";
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "B", slug: TENANT_B } });
    const b = await prismaBase.integration.create({ data: { tenantId: TENANT_B, provider: "WOOCOMMERCE", status: "CONNECTE", config: { siteUrl: "https://b.example.com" } } });
    const a = await seedIntegration();
    const admin = await loginAsTestUser({ role: "ADMIN" });

    expect(await setWooCommerceRemoteDeletionModeAction("tout-supprimer")).toMatchObject({ ok: false, error: "Choix invalide." });
    expect(await setWooCommerceRemoteDeletionModeAction("auto")).toEqual({ ok: true, data: { mode: "auto" } });

    expect(remoteDeletionModeOf((await prismaBase.integration.findUniqueOrThrow({ where: { id: a.id } })).config)).toBe("auto");
    expect(remoteDeletionModeOf((await prismaBase.integration.findUniqueOrThrow({ where: { id: b.id } })).config)).toBe("manual");
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: a.id, action: "integration.updated" } });
    expect(audit.actorUserId).toBe(admin.id);
    expect(audit.metadata).toMatchObject({ change: "remote_deletion_mode", previous: "manual", mode: "auto" });
  });

  it("refuses a user without integrations.manage", async () => {
    const integration = await seedIntegration();
    await loginAsTestUser({ role: "MANAGER" });
    await expect(setWooCommerceRemoteDeletionModeAction("auto")).rejects.toThrow(/autoris/i);
    expect(remoteDeletionModeOf((await prisma.integration.findUniqueOrThrow({ where: { id: integration.id } })).config)).toBe("manual");
  });
});

describe("store's product.deleted webhook", () => {
  it("manual (default): a confirmed deletion is flagged and notified, never unlinked — stock and history intact", async () => {
    await seedIntegration();
    const admin = await createTestUser({ role: "ADMIN" });
    const { imported, variation } = await seedCatalog();
    state.productGetErrors = { 501: DELETED };
    const before = await stockSnapshot();

    await deletedWebhook(501);

    const product = await prisma.product.findUniqueOrThrow({ where: { id: imported.id } });
    expect(product).toMatchObject({ source: "WOOCOMMERCE", externalId: "501", status: "ARCHIVE" }); // archive = existing behaviour
    expect(await prisma.productVariation.findUniqueOrThrow({ where: { id: variation.id } })).toMatchObject({ source: "WOOCOMMERCE", externalId: "5011" });
    expect(await pendingRemoteMissing({ productId: imported.id, externalId: "501" })).toMatchObject({ check: "deleted" });
    const notes = await prisma.notification.findMany({ where: { userId: admin.id, entityId: imported.id } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ type: "ERREUR_INTEGRATION", title: "Produit supprimé de WooCommerce" });
    expect(await stockSnapshot()).toEqual(before);
  });

  it("automatic: a deletion the store confirms unlinks the product, its variations and publication — nothing else", async () => {
    await seedIntegration({ remoteDeletionMode: "auto" });
    const admin = await createTestUser({ role: "ADMIN" });
    const { imported, variation } = await seedCatalog();
    await prisma.productPublication.create({ data: { productId: imported.id, provider: "WOOCOMMERCE", externalId: "501" } }); // adopted products carry one
    state.productGetErrors = { 501: DELETED };
    const before = await stockSnapshot();

    await deletedWebhook(501);

    expect(await prisma.product.findUniqueOrThrow({ where: { id: imported.id } })).toMatchObject({ source: "INTERNE", externalId: null, name: "Tee importé", sku: "TEE-WC" });
    expect(await prisma.productVariation.findUniqueOrThrow({ where: { id: variation.id } })).toMatchObject({ source: "INTERNE", externalId: null, sku: "TEE-WC-M" });
    expect(await prisma.productPublication.count({ where: { productId: imported.id } })).toBe(0);
    expect(await stockSnapshot()).toEqual(before); // quantities, movements, order lines untouched
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: imported.id, action: "product.remote_unlinked" } });
    expect(audit.actorType).toBe("INTEGRATION");
    expect(audit.metadata).toMatchObject({ provider: "WOOCOMMERCE", externalId: "501", link: "imported", mode: "auto", check: "deleted", reason: "auto_confirmed_deletion", unlinkedVariations: 1 });
    expect(await prisma.notification.findMany({ where: { userId: admin.id, entityId: imported.id }, select: { title: true } })).toEqual([{ title: "Produit dissocié de WooCommerce" }]);
  });

  it("automatic: a published ASODITECH product loses only its publication and is exportable again", async () => {
    await seedIntegration({ remoteDeletionMode: "auto" });
    const { published } = await seedCatalog();
    state.productGetErrors = { 601: DELETED };
    const notPublished = () => prisma.product.findMany({ where: exportFilterWhere({ notPublishedTo: "woocommerce" }), select: { id: true } });
    expect((await notPublished()).map((p) => p.id)).not.toContain(published.id);

    await deletedWebhook(601);

    expect(await prisma.product.findUniqueOrThrow({ where: { id: published.id } })).toMatchObject({ source: "INTERNE", status: "ACTIF" });
    expect(await prisma.productPublication.count({ where: { productId: published.id } })).toBe(0);
    expect((await notPublished()).map((p) => p.id)).toContain(published.id);
  });

  it.each([
    ["in the store's trash (reversible)", "trash" as const],
    ["timeout", "timeout" as const],
    ["network failure", "network" as const],
    ["401 expired key", { status: 401, body: wooErrorBody("woocommerce_rest_cannot_view", "Désolé", 401) }],
    ["403 forbidden", { status: 403, body: wooErrorBody("woocommerce_rest_cannot_view", "Interdit", 403) }],
    ["429 rate limit", { status: 429, body: "{}" }],
    ["500 server error", { status: 500, body: "<html>erreur</html>" }],
    ["404 without WooCommerce's product slug (wrong URL / REST disabled)", { status: 404, body: wooErrorBody("rest_no_route", "Aucune route", 404) }],
    ["404 HTML page", { status: 404, body: "<html>Not found</html>" }],
  ])("automatic mode + %s → never unlinked, flagged for manual review", async (_, answer) => {
    await seedIntegration({ remoteDeletionMode: "auto" });
    const { imported } = await seedCatalog();
    if (answer === "trash") {
      state.products.push({ id: 501, name: "Tee importé", slug: "tee", sku: "TEE-WC", status: "trash", type: "simple", regular_price: "100", price: "100", manage_stock: false, stock_quantity: null, categories: [], images: [], variations: [] } as never);
    } else {
      state.productGetErrors = { 501: answer };
    }
    const before = await stockSnapshot();

    await deletedWebhook(501);

    expect(await prisma.product.findUniqueOrThrow({ where: { id: imported.id } })).toMatchObject({ source: "WOOCOMMERCE", externalId: "501" });
    expect(await auditCount("product.remote_unlinked", imported.id)).toBe(0);
    expect(await pendingRemoteMissing({ productId: imported.id, externalId: "501" })).toMatchObject({ check: answer === "trash" ? "trashed" : "unknown" });
    expect(await stockSnapshot()).toEqual(before);
  }, 20_000);

  it("is idempotent: repeated deliveries flag / unlink once, notify once", async () => {
    await seedIntegration();
    const admin = await createTestUser({ role: "ADMIN" });
    const { imported } = await seedCatalog();
    state.productGetErrors = { 501: DELETED };
    await deletedWebhook(501);
    await deletedWebhook(501);
    expect(await auditCount("product.remote_missing", imported.id)).toBe(1);
    expect(await prisma.notification.count({ where: { userId: admin.id, entityId: imported.id } })).toBe(1);

    await prisma.integration.updateMany({ data: { config: { siteUrl: FAKE_STORE_URL, remoteDeletionMode: "auto" } } });
    await deletedWebhook(501);
    await deletedWebhook(501);
    expect(await auditCount("product.remote_unlinked", imported.id)).toBe(1);
    expect(await prisma.notification.findMany({ where: { userId: admin.id, entityId: imported.id }, select: { title: true } })).toEqual([{ title: "Produit dissocié de WooCommerce" }]);
  });

  it("trash in manual mode: imported and published products flagged « corbeille », never unlinked; restore clears it once — no duplicate, no stock written or pushed", async () => {
    await seedIntegration();
    const { imported, variation, published } = await seedCatalog();
    const trashed = (id: number, sku: string, status: string) =>
      ({
        id,
        name: `Produit ${sku}`,
        slug: sku.toLowerCase(),
        sku,
        status,
        type: id === 501 ? "variable" : "simple",
        regular_price: "100",
        price: "100",
        manage_stock: false,
        stock_quantity: null,
        categories: [],
        images: [],
        variations: id === 501 ? [5011] : [],
        variationList:
          id === 501 ? [{ id: 5011, sku: "TEE-WC-M", regular_price: "100", manage_stock: true, stock_quantity: 40, attributes: [{ name: "Taille", option: "M" }] }] : [],
      }) as never;
    state.products.push(trashed(501, "TEE-WC", "trash"), trashed(601, "BOUGIE-1", "trash"));
    const before = await stockSnapshot();

    await deletedWebhook(501);
    await deletedWebhook(601);
    await deletedWebhook(501); // a retry

    expect(await prisma.product.findUniqueOrThrow({ where: { id: imported.id } })).toMatchObject({ source: "WOOCOMMERCE", externalId: "501" });
    expect(await prisma.productPublication.count({ where: { productId: published.id, externalId: "601" } })).toBe(1);
    expect(await pendingRemoteMissing({ productId: imported.id, externalId: "501" })).toMatchObject({ check: "trashed" });
    expect(await pendingRemoteMissing({ productId: published.id, externalId: "601" })).toMatchObject({ check: "trashed" });
    expect(await auditCount("product.remote_missing", imported.id)).toBe(1);
    expect(await auditCount("product.remote_unlinked", imported.id) + (await auditCount("product.remote_unlinked", published.id))).toBe(0);

    // back from the trash
    (state.products as { id: number; status: string }[]).forEach((p) => (p.status = "publish"));
    await restoredWebhook(501);
    await restoredWebhook(501);

    expect(await pendingRemoteMissing({ productId: imported.id, externalId: "501" })).toBeNull();
    expect(await prisma.product.count({ where: { sku: { startsWith: "TEE-WC" } } })).toBe(1);
    expect(await prisma.productVariation.findMany({ where: { productId: imported.id }, select: { id: true } })).toEqual([{ id: variation.id }]);
    expect(await stockSnapshot()).toEqual(before); // the store's 40 is not pulled by a webhook, no row added
    expect(state.stockUpdates).toHaveLength(0);
    expect(await auditCount("product.remote_missing_cleared", imported.id)).toBe(1);
  }, 20_000);

  it("concurrent deliveries (webhook retries racing each other) flag once and clear once — one audit event each, one notification", async () => {
    await seedIntegration();
    const admin = await createTestUser({ role: "ADMIN" });
    const { imported } = await seedCatalog();
    state.productGetErrors = { 501: DELETED };
    await Promise.all([1, 2, 3, 4, 5].map(() => deletedWebhook(501)));
    expect(await auditCount("product.remote_missing", imported.id)).toBe(1);
    expect(await prisma.notification.count({ where: { userId: admin.id, entityId: imported.id } })).toBe(1);

    state.productGetErrors = {};
    state.products.push({ id: 501, name: "Tee importé", slug: "tee", sku: "TEE-WC", status: "publish", type: "simple", regular_price: "100", price: "100", manage_stock: false, stock_quantity: null, categories: [], images: [], variations: [] } as never);
    await Promise.all([1, 2, 3, 4].map(() => restoredWebhook(501)));
    expect(await auditCount("product.remote_missing_cleared", imported.id)).toBe(1);
    expect(await prisma.notification.count({ where: { userId: admin.id, entityId: imported.id } })).toBe(0);
  }, 30_000);

  it("a product the store still has is not flagged", async () => {
    await seedIntegration({ remoteDeletionMode: "auto" });
    const { imported } = await seedCatalog();
    state.products.push({ id: 501, name: "Tee importé", slug: "tee", sku: "TEE-WC", status: "publish", type: "simple", regular_price: "100", price: "100", manage_stock: false, stock_quantity: null, categories: [], images: [], variations: [] } as never);
    await deletedWebhook(501);
    expect(await pendingRemoteMissing({ productId: imported.id, externalId: "501" })).toBeNull();
    expect(await prisma.product.findUniqueOrThrow({ where: { id: imported.id } })).toMatchObject({ source: "WOOCOMMERCE", externalId: "501" });
  });

  it("company A's manual choice holds even when company B chose automatic", async () => {
    const TENANT_B = "tenant-b-remote-auto";
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "B", slug: TENANT_B } });
    await prismaBase.integration.create({
      data: {
        tenantId: TENANT_B,
        provider: "WOOCOMMERCE",
        status: "CONNECTE",
        config: { siteUrl: "https://b.example.com", remoteDeletionMode: "auto" },
        credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: "ck_b", apiSecret: "cs_b", webhookSecret: "secret-b" })),
      },
    });
    await seedIntegration(); // A: manual (unset)
    const { imported } = await seedCatalog();
    state.productGetErrors = { 501: DELETED };

    await deletedWebhook(501);

    expect(await prisma.product.findUniqueOrThrow({ where: { id: imported.id } })).toMatchObject({ source: "WOOCOMMERCE", externalId: "501" });
    expect(await pendingRemoteMissing({ productId: imported.id, externalId: "501" })).not.toBeNull();
  });
});

describe("product page: check and confirmed unlinking", () => {
  it("an authorised user confirms the unlinking of a flagged product; the store is re-checked first", async () => {
    await seedIntegration();
    const { imported } = await seedCatalog();
    state.productGetErrors = { 501: DELETED };
    await deletedWebhook(501);
    const before = await stockSnapshot();
    const admin = await loginAsTestUser({ role: "ADMIN" });

    expect(await unlinkWooCommerceProductAction({ productId: imported.id })).toEqual({ ok: true, data: { unlinked: true } });
    expect(await prisma.product.findUniqueOrThrow({ where: { id: imported.id } })).toMatchObject({ source: "INTERNE", externalId: null });
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: imported.id, action: "product.remote_unlinked" } });
    expect(audit).toMatchObject({ actorType: "USER", actorUserId: admin.id });
    expect(audit.metadata).toMatchObject({ mode: "manual", reason: "user_confirmed", check: "deleted" });
    expect(await pendingRemoteMissing({ productId: imported.id, externalId: "501" })).toBeNull();
    expect(await stockSnapshot()).toEqual(before);
    // a second confirmation changes nothing
    expect(await unlinkWooCommerceProductAction({ productId: imported.id })).toMatchObject({ ok: false });
    expect(await auditCount("product.remote_unlinked", imported.id)).toBe(1);
  });

  it("never unlinks a product the store still has, nor an unverifiable one that was never flagged", async () => {
    await seedIntegration();
    const { imported } = await seedCatalog();
    await loginAsTestUser({ role: "ADMIN" });
    state.products.push({ id: 501, name: "Tee importé", slug: "tee", sku: "TEE-WC", status: "publish", type: "simple", regular_price: "100", price: "100", manage_stock: false, stock_quantity: null, categories: [], images: [], variations: [] } as never);
    expect(await unlinkWooCommerceProductAction({ productId: imported.id })).toMatchObject({ ok: false, error: expect.stringContaining("existe toujours") });

    state.products = [];
    state.productGetErrors = { 501: { status: 500, body: "{}" } };
    expect(await unlinkWooCommerceProductAction({ productId: imported.id })).toMatchObject({ ok: false, error: expect.stringContaining("Impossible de vérifier") });
    expect(await prisma.product.findUniqueOrThrow({ where: { id: imported.id } })).toMatchObject({ source: "WOOCOMMERCE", externalId: "501" });
  }, 20_000);

  it("« Vérifier sur la boutique » applies the company's rule; an unreachable store changes nothing", async () => {
    await seedIntegration();
    const { imported } = await seedCatalog();
    await loginAsTestUser({ role: "ADMIN" });
    state.productGetErrors = { 501: "timeout" };
    expect(await checkWooCommerceRemoteProductAction({ productId: imported.id })).toEqual({ ok: true, data: { check: "unknown", result: "unknown" } });
    expect(await pendingRemoteMissing({ productId: imported.id, externalId: "501" })).toBeNull();

    state.productGetErrors = { 501: DELETED };
    expect(await checkWooCommerceRemoteProductAction({ productId: imported.id })).toEqual({ ok: true, data: { check: "deleted", result: "flagged" } });
    expect(await prisma.product.findUniqueOrThrow({ where: { id: imported.id } })).toMatchObject({ source: "WOOCOMMERCE" });
  });

  it("refuses users without integrations.manage, and another company's product", async () => {
    await seedIntegration();
    const { imported } = await seedCatalog();
    state.productGetErrors = { 501: DELETED };
    await loginAsTestUser({ role: "MANAGER" });
    expect(await unlinkWooCommerceProductAction({ productId: imported.id })).toMatchObject({ ok: false, error: expect.stringContaining("permission") });
    expect(await checkWooCommerceRemoteProductAction({ productId: imported.id })).toMatchObject({ ok: false });

    const TENANT_B = "tenant-b-remote-actor";
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "B", slug: TENANT_B } });
    await loginAsTestUser({ role: "ADMIN", tenantId: TENANT_B });
    expect(await unlinkWooCommerceProductAction({ productId: imported.id })).toMatchObject({ ok: false });
    expect(await prismaBase.product.findUniqueOrThrow({ where: { id: imported.id } })).toMatchObject({ source: "WOOCOMMERCE", externalId: "501" });
  });

  it("reconnecting stays the existing workflow: the next import re-links the unlinked product by SKU, no duplicate", async () => {
    await seedIntegration({ remoteDeletionMode: "auto" });
    const product = await prisma.product.create({ data: { name: "Savon", sku: "SAVON-1", price: 30, status: "ACTIF", source: "WOOCOMMERCE", externalId: "701" } });
    state.productGetErrors = { 701: DELETED };
    await deletedWebhook(701);
    expect(await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).toMatchObject({ source: "INTERNE", externalId: null });

    // the merchant re-creates it in the store under a new id
    state.products.push({ id: 702, name: "Savon", slug: "savon", sku: "SAVON-1", status: "publish", type: "simple", regular_price: "30", price: "30", manage_stock: false, stock_quantity: null, categories: [], images: [], variations: [] } as never);
    await loginAsTestUser({ role: "ADMIN" });
    expect((await syncWooCommerceProductsAction()).ok).toBe(true);
    expect(await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).toMatchObject({ source: "WOOCOMMERCE", externalId: "702" });
    expect(await prisma.product.count({ where: { sku: { startsWith: "SAVON-1" } } })).toBe(1);
  });
});
