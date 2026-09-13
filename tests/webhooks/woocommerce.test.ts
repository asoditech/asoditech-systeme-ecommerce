import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import { POST } from "@/app/api/webhooks/woocommerce/route";
import { updateOrderStatusAction, cancelOrderAction } from "@/actions/orders";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";
import { createTestUser, loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

const WEBHOOK_SECRET = "test-webhook-secret";

async function seedIntegration(configOverrides: Record<string, unknown> = {}) {
  return prisma.integration.create({
    data: {
      provider: "WOOCOMMERCE",
      status: "CONNECTE",
      config: { siteUrl: "https://example.com", ...configOverrides },
      credentialsEncrypted: encryptSecret(
        JSON.stringify({ apiKey: "ck_x", apiSecret: "cs_x", webhookSecret: WEBHOOK_SECRET })
      ),
    },
  });
}

/** A second tenant with its own WOOCOMMERCE integration and its own
 * webhook secret — provider is no longer globally unique (Phase 3, docs/adr/0025). */
async function seedTenantBIntegration(secret: string) {
  const TENANT_B = "tenant-b-wc-webhook";
  await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
  const integration = await prismaBase.integration.create({
    data: {
      tenantId: TENANT_B,
      provider: "WOOCOMMERCE",
      status: "CONNECTE",
      config: { siteUrl: "https://tenant-b.example.com" },
      credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: "ck_b", apiSecret: "cs_b", webhookSecret: secret })),
    },
  });
  return { tenantId: TENANT_B, integration };
}

function sign(body: string, secret = WEBHOOK_SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

function orderPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: 7001,
    number: "7001",
    status: "processing",
    currency: "MAD",
    date_created: "2026-01-20T10:00:00",
    date_paid: null,
    customer_id: 0,
    total: "50.00",
    total_tax: "0.00",
    shipping_total: "0.00",
    discount_total: "0.00",
    payment_method: "cod",
    billing: {
      first_name: "Web",
      last_name: "Hook",
      email: "webhook@example.com",
      city: "Casablanca",
      country: "MA",
      address_1: "1 Rue Test",
    },
    shipping: {},
    line_items: [
      { id: 1, name: "Produit test", product_id: null, sku: "SKU-X", quantity: 1, price: "50.00", subtotal: "50.00", total: "50.00" },
    ],
    refunds: [],
    ...overrides,
  });
}

function productPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: 5001,
    name: "Produit webhook",
    slug: "produit-webhook",
    sku: "WEBHOOK-SKU",
    status: "publish",
    type: "simple",
    regular_price: "42.00",
    manage_stock: true,
    stock_quantity: 8,
    categories: [],
    ...overrides,
  });
}

function request(body: string, headers: Record<string, string>): Request {
  return new Request("https://app.example/api/webhooks/woocommerce", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("POST /api/webhooks/woocommerce", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("returns 404 when no WooCommerce integration is configured", async () => {
    const body = orderPayload();
    const response = await POST(
      request(body, { "x-wc-webhook-signature": sign(body), "x-wc-webhook-topic": "order.created", "x-wc-webhook-delivery-id": "d1" })
    );
    expect(response.status).toBe(404);
  });

  it("processes a validly signed order.created delivery and creates the order", async () => {
    await seedIntegration();
    const staff = await createTestUser({ role: "CONFIRMATION" }); // holds orders.view
    const body = orderPayload();
    const response = await POST(
      request(body, { "x-wc-webhook-signature": sign(body), "x-wc-webhook-topic": "order.created", "x-wc-webhook-delivery-id": "d1" })
    );
    expect(response.status).toBe(200);

    const order = await prisma.order.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "7001" } });
    expect(Number(order.total)).toBe(50);

    const event = await prisma.webhookEvent.findFirstOrThrow({ where: { deliveryId: "d1" } });
    expect(event.status).toBe("TRAITE");

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "integration.webhook_received" } });
    expect(audit).toBeTruthy();

    // docs/adr/0016-notifications.md — a webhook has no acting user
    // (actor: { type: "INTEGRATION" }), so every orders.view holder is
    // notified, no one excepted.
    const notification = await prisma.notification.findFirstOrThrow({ where: { userId: staff.id } });
    expect(notification.type).toBe("NOUVELLE_COMMANDE");
  });

  // docs/adr/0030's 2026-09-13 addendum: this is now the DEFAULT behavior
  // (config unset, or forceNouvelleOnImport explicitly true), not an
  // opt-in — a first-time "processing" order never auto-lands as
  // Confirmée. Only CONFIRMATION inside ASODITECH reserves stock.
  it("a first-time import lands as NOUVELLE by default, even for a 'processing' order (config unset)", async () => {
    await seedIntegration();
    const body = orderPayload();
    const response = await POST(
      request(body, { "x-wc-webhook-signature": sign(body), "x-wc-webhook-topic": "order.created", "x-wc-webhook-delivery-id": "d-default-nouvelle" })
    );
    expect(response.status).toBe(200);

    const order = await prisma.order.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "7001" } });
    expect(order.status).toBe("NOUVELLE");

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "order.created", entityId: order.id } });
    expect((audit.metadata as Record<string, unknown>).forcedNouvelleFromWcStatus).toBe("processing");
  });

  it("forces a first-time import to NOUVELLE when forceNouvelleOnImport is explicitly true, even for a 'processing' order", async () => {
    await seedIntegration({ forceNouvelleOnImport: true });
    const body = orderPayload();
    const response = await POST(
      request(body, { "x-wc-webhook-signature": sign(body), "x-wc-webhook-topic": "order.created", "x-wc-webhook-delivery-id": "d-force-nouvelle" })
    );
    expect(response.status).toBe(200);

    const order = await prisma.order.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "7001" } });
    expect(order.status).toBe("NOUVELLE");

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "order.created", entityId: order.id } });
    expect((audit.metadata as Record<string, unknown>).forcedNouvelleFromWcStatus).toBe("processing");
  });

  it("trusts WooCommerce's own status when forceNouvelleOnImport is explicitly disabled (opt-out)", async () => {
    await seedIntegration({ forceNouvelleOnImport: false });
    const body = orderPayload();
    const response = await POST(
      request(body, { "x-wc-webhook-signature": sign(body), "x-wc-webhook-topic": "order.created", "x-wc-webhook-delivery-id": "d-no-force" })
    );
    expect(response.status).toBe(200);

    const order = await prisma.order.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "7001" } });
    expect(order.status).toBe("CONFIRMEE");
  });

  // 2026-09-13 fix: the actual gap behind orders #15606/#15607 showing
  // CONFIRMEE in production. order.created landed the order as NOUVELLE
  // ("pending" maps straight to NOUVELLE, no forcing needed) — then WC
  // moved the order to "processing" and fired order.updated. The OLD
  // updateExistingOrder always applied the store's real status once the
  // order already existed, silently promoting NOUVELLE -> CONFIRMEE
  // without forceNouvelleOnImport ever getting a say (it only looked at
  // the FIRST snapshot). This is now blocked exactly like first import.
  it("a later webhook update reporting 'processing' does NOT silently promote an already-NOUVELLE order to CONFIRMEE", async () => {
    await seedIntegration(); // default: force-Nouvelle on
    const created = orderPayload({ status: "pending" });
    const createdResponse = await POST(
      request(created, { "x-wc-webhook-signature": sign(created), "x-wc-webhook-topic": "order.created", "x-wc-webhook-delivery-id": "d-created-pending" })
    );
    expect(createdResponse.status).toBe(200);
    let order = await prisma.order.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "7001" } });
    expect(order.status).toBe("NOUVELLE");

    const updated = orderPayload({ status: "processing", date_paid: "2026-01-20T10:05:00" });
    const updatedResponse = await POST(
      request(updated, { "x-wc-webhook-signature": sign(updated), "x-wc-webhook-topic": "order.updated", "x-wc-webhook-delivery-id": "d-updated-processing" })
    );
    expect(updatedResponse.status).toBe(200);

    order = await prisma.order.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "7001" } });
    expect(order.status).toBe("NOUVELLE"); // still requires a human confirmation inside ASODITECH

    const item = await prisma.inventoryItem.findFirst();
    expect(item).toBeNull(); // no product line resolved in this fixture — nothing was reserved either way
  });

  it("with forceNouvelleOnImport explicitly disabled, a later webhook update DOES apply the real status (opt-out honored on update too)", async () => {
    await seedIntegration({ forceNouvelleOnImport: false });
    const created = orderPayload({ status: "pending" });
    await POST(request(created, { "x-wc-webhook-signature": sign(created), "x-wc-webhook-topic": "order.created", "x-wc-webhook-delivery-id": "d-created-pending-2" }));
    let order = await prisma.order.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "7001" } });
    expect(order.status).toBe("NOUVELLE"); // "pending" always maps to NOUVELLE regardless of the setting

    const updated = orderPayload({ status: "processing" });
    await POST(request(updated, { "x-wc-webhook-signature": sign(updated), "x-wc-webhook-topic": "order.updated", "x-wc-webhook-delivery-id": "d-updated-processing-2" }));
    order = await prisma.order.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "7001" } });
    expect(order.status).toBe("CONFIRMEE");
  });

  it("a later webhook update still applies every OTHER transition normally (e.g. processing -> completed)", async () => {
    await seedIntegration({ forceNouvelleOnImport: false }); // opt-out so the order starts CONFIRMEE, to isolate the non-NOUVELLE transition
    const created = orderPayload({ status: "processing" });
    await POST(request(created, { "x-wc-webhook-signature": sign(created), "x-wc-webhook-topic": "order.created", "x-wc-webhook-delivery-id": "d-created-processing-3" }));
    let order = await prisma.order.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "7001" } });
    expect(order.status).toBe("CONFIRMEE");

    // CONFIRMEE -> LIVREE isn't a direct transition in ASODITECH's state
    // machine, so the guard correctly leaves it alone (statusSkippedReason,
    // not the new autoConfirmBlocked path) — this proves the fix is scoped
    // to NOUVELLE -> CONFIRMEE only, not a blanket "ignore all updates".
    const updated = orderPayload({ status: "completed" });
    await POST(request(updated, { "x-wc-webhook-signature": sign(updated), "x-wc-webhook-topic": "order.updated", "x-wc-webhook-delivery-id": "d-updated-completed-3" }));
    order = await prisma.order.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "7001" } });
    expect(order.status).toBe("CONFIRMEE"); // unchanged — not a valid direct transition, same as before this fix
  });

  // Task 3, through the actual webhook path (TEST 6): a first-time
  // WooCommerce import whose line quantity exceeds available stock fires
  // the read-only alert too — never blocks the import, never touches
  // stock (checkAndNotifyInsufficientStockForOrder, called from
  // createImportedOrder for any actor including a webhook).
  it("a newly imported order requesting more than available stock fires a stock-insufficient alert (never blocks import, never touches stock)", async () => {
    await seedIntegration();
    const staff = await createTestUser({ role: "CONFIRMATION" }); // holds orders.view
    const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt", isDefault: true } });
    const product = await prisma.product.create({
      data: { name: "Produit simple 01", sku: "SKU-501", price: 50, status: "ACTIF", source: "WOOCOMMERCE", externalId: "501" },
    });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 3 } });

    const body = orderPayload({
      line_items: [{ id: 1, name: "Produit simple 01", product_id: 501, sku: "SKU-501", quantity: 10, price: "50.00", subtotal: "500.00", total: "500.00" }],
    });
    const response = await POST(
      request(body, { "x-wc-webhook-signature": sign(body), "x-wc-webhook-topic": "order.created", "x-wc-webhook-delivery-id": "d-insufficient" })
    );
    expect(response.status).toBe(200);

    const order = await prisma.order.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "7001" } });
    const insufficient = await prisma.notification.findFirstOrThrow({
      where: { userId: staff.id, type: "STOCK_INSUFFISANT_COMMANDE" },
    });
    expect(insufficient.message).toContain("Produit simple 01");
    expect(insufficient.message).toContain("10 demandée(s), 3 disponible(s), 7 manquante(s)");
    expect(insufficient.entityId).toBe(order.id);

    // Never blocked the import, never touched stock.
    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(item).toMatchObject({ quantityOnHand: 3, quantityReserved: 0 });
  });

  it("rejects an invalid signature with 401 and creates no order", async () => {
    await seedIntegration();
    const body = orderPayload();
    const response = await POST(
      request(body, { "x-wc-webhook-signature": sign(body, "wrong-secret"), "x-wc-webhook-topic": "order.created", "x-wc-webhook-delivery-id": "d2" })
    );
    expect(response.status).toBe(401);

    const order = await prisma.order.findFirst({ where: { source: "WOOCOMMERCE", externalId: "7001" } });
    expect(order).toBeNull();

    const rejected = await prisma.auditEvent.findFirstOrThrow({ where: { action: "integration.webhook_rejected" } });
    expect(rejected).toBeTruthy();
  });

  // Phase 3 (docs/adr/0025): provider is no longer globally unique, so the
  // tenant is resolved by matching the signature against every WOOCOMMERCE
  // integration across every tenant.
  it("resolves the correct tenant among two WooCommerce integrations by signature", async () => {
    await seedIntegration(); // tenant A, WEBHOOK_SECRET
    const TENANT_B_SECRET = "tenant-b-secret";
    const { tenantId: TENANT_B } = await seedTenantBIntegration(TENANT_B_SECRET);

    const body = orderPayload({ id: 8002 });
    const response = await POST(
      request(body, {
        "x-wc-webhook-signature": sign(body, TENANT_B_SECRET),
        "x-wc-webhook-topic": "order.created",
        "x-wc-webhook-delivery-id": "d-tenant-b",
      })
    );
    expect(response.status).toBe(200);

    const orderB = await prismaBase.order.findFirst({ where: { source: "WOOCOMMERCE", externalId: "8002" } });
    expect(orderB?.tenantId).toBe(TENANT_B);

    const orderA = await prismaBase.order.findFirst({
      where: { source: "WOOCOMMERCE", externalId: "8002", tenantId: DEFAULT_TENANT_ID },
    });
    expect(orderA).toBeNull();
  });

  it("a signature that matches no tenant's integration is rejected with 401, attributed to no specific integration", async () => {
    await seedIntegration();
    await seedTenantBIntegration("tenant-b-secret");

    const body = orderPayload({ id: 8003 });
    const response = await POST(
      request(body, {
        "x-wc-webhook-signature": sign(body, "some-other-secret"),
        "x-wc-webhook-topic": "order.created",
        "x-wc-webhook-delivery-id": "d-nobody",
      })
    );
    expect(response.status).toBe(401);
    const order = await prismaBase.order.findFirst({ where: { source: "WOOCOMMERCE", externalId: "8003" } });
    expect(order).toBeNull();

    const rejected = await prismaBase.auditEvent.findFirstOrThrow({
      where: { action: "integration.webhook_rejected", entityId: "unknown" },
    });
    expect(rejected).toBeTruthy();
  });

  it("rejects a missing signature header with 401", async () => {
    await seedIntegration();
    const body = orderPayload();
    const response = await POST(request(body, { "x-wc-webhook-topic": "order.created", "x-wc-webhook-delivery-id": "d3" }));
    expect(response.status).toBe(401);
  });

  it("rejects a request with no delivery id", async () => {
    await seedIntegration();
    const body = orderPayload();
    const response = await POST(
      request(body, { "x-wc-webhook-signature": sign(body), "x-wc-webhook-topic": "order.created" })
    );
    expect(response.status).toBe(400);
  });

  it("is idempotent under a replayed (duplicate) delivery id — processes once, no-ops the second time", async () => {
    await seedIntegration();
    const body = orderPayload();
    const headers = { "x-wc-webhook-signature": sign(body), "x-wc-webhook-topic": "order.created", "x-wc-webhook-delivery-id": "d4" };

    const first = await POST(request(body, headers));
    expect(first.status).toBe(200);
    const second = await POST(request(body, headers));
    expect(second.status).toBe(200);

    const orders = await prisma.order.findMany({ where: { source: "WOOCOMMERCE", externalId: "7001" } });
    expect(orders).toHaveLength(1);
    const events = await prisma.webhookEvent.findMany({ where: { deliveryId: "d4" } });
    expect(events).toHaveLength(1);
  });

  it("handles concurrent duplicate deliveries without creating two orders or crashing (audit fix)", async () => {
    await seedIntegration();
    const body = orderPayload();
    const headers = { "x-wc-webhook-signature": sign(body), "x-wc-webhook-topic": "order.created", "x-wc-webhook-delivery-id": "d-concurrent" };

    const [a, b] = await Promise.all([POST(request(body, headers)), POST(request(body, headers))]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const orders = await prisma.order.findMany({ where: { source: "WOOCOMMERCE", externalId: "7001" } });
    expect(orders).toHaveLength(1);
    const events = await prisma.webhookEvent.findMany({ where: { deliveryId: "d-concurrent" } });
    expect(events).toHaveLength(1);
  });

  it("acknowledges (200) but ignores an unsupported topic without importing anything", async () => {
    await seedIntegration();
    const body = orderPayload();
    const response = await POST(
      request(body, { "x-wc-webhook-signature": sign(body), "x-wc-webhook-topic": "coupon.created", "x-wc-webhook-delivery-id": "d5" })
    );
    expect(response.status).toBe(200);

    const order = await prisma.order.findFirst({ where: { source: "WOOCOMMERCE", externalId: "7001" } });
    expect(order).toBeNull();

    const event = await prisma.webhookEvent.findFirstOrThrow({ where: { deliveryId: "d5" } });
    expect(event.status).toBe("IGNORE");
  });

  it("archives a product on a product.deleted delivery, keeping its history", async () => {
    await seedIntegration();
    const product = await prisma.product.create({
      data: { name: "Vieux produit", sku: "WC-DEL-1", price: 100, status: "ACTIF", source: "WOOCOMMERCE", externalId: "9500" },
    });
    const body = JSON.stringify({ id: 9500 });
    const response = await POST(
      request(body, { "x-wc-webhook-signature": sign(body), "x-wc-webhook-topic": "product.deleted", "x-wc-webhook-delivery-id": "d-del" })
    );
    expect(response.status).toBe(200);

    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.status).toBe("ARCHIVE");
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: product.id, action: "product.archived" } });
    expect(audit.actorType).toBe("INTEGRATION");
  });

  it("product.deleted for an unknown product is a no-op 200", async () => {
    await seedIntegration();
    const body = JSON.stringify({ id: 424242 });
    const response = await POST(
      request(body, { "x-wc-webhook-signature": sign(body), "x-wc-webhook-topic": "product.deleted", "x-wc-webhook-delivery-id": "d-del-2" })
    );
    expect(response.status).toBe(200);
  });

  it("rejects a malformed (non-JSON) body with 400", async () => {
    await seedIntegration();
    const body = "not json at all";
    const response = await POST(
      request(body, { "x-wc-webhook-signature": sign(body), "x-wc-webhook-topic": "order.created", "x-wc-webhook-delivery-id": "d6" })
    );
    expect(response.status).toBe(400);
  });

  it("rejects a well-formed JSON body that doesn't match the expected order shape", async () => {
    await seedIntegration();
    const body = JSON.stringify({ not: "an order" });
    const response = await POST(
      request(body, { "x-wc-webhook-signature": sign(body), "x-wc-webhook-topic": "order.created", "x-wc-webhook-delivery-id": "d7" })
    );
    expect(response.status).toBe(400);
  });

  it("processes order.updated the same way as order.created", async () => {
    await seedIntegration();
    const body = orderPayload({ status: "completed" });
    const response = await POST(
      request(body, { "x-wc-webhook-signature": sign(body), "x-wc-webhook-topic": "order.updated", "x-wc-webhook-delivery-id": "d8" })
    );
    expect(response.status).toBe(200);
    const order = await prisma.order.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "7001" } });
    expect(order.status).toBe("LIVREE");
  });

  describe("product.created / product.updated (real-time product sync)", () => {
    // 2026-09-13 fix (docs/adr/0030's addendum): the webhook path no longer
    // reconciles stock at all — see syncOneProduct's `reconcileStock` doc
    // comment in src/lib/integrations/woocommerce/sync/products.ts. Product
    // fields (name/price/sku/etc.) still import in real time.
    it("imports a new product from a product.created delivery WITHOUT seeding stock — no InventoryItem row yet", async () => {
      await seedIntegration();
      await prisma.warehouse.create({ data: { id: "wh-default", name: "Entrepôt principal", isDefault: true } });
      const body = productPayload();
      const response = await POST(
        request(body, { "x-wc-webhook-signature": sign(body), "x-wc-webhook-topic": "product.created", "x-wc-webhook-delivery-id": "p1" })
      );
      expect(response.status).toBe(200);

      const product = await prisma.product.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "5001" } });
      expect(product.sku).toBe("WEBHOOK-SKU");
      expect(Number(product.price)).toBe(42);

      // Stock seeding is deliberately deferred to the explicit "Synchroniser
      // les produits" bulk action — see the root-cause fix.
      const item = await prisma.inventoryItem.findFirst({ where: { productId: product.id } });
      expect(item).toBeNull();

      const event = await prisma.webhookEvent.findFirstOrThrow({ where: { deliveryId: "p1" } });
      expect(event.status).toBe("TRAITE");
    });

    // This is the exact root cause of the production incident: WooCommerce
    // auto-decrements its OWN stock_quantity the instant an order is
    // placed (before ASODITECH ever confirms anything) and fires
    // product.updated as a side effect. Reconciling from that webhook used
    // to silently overwrite quantityOnHand — this proves it no longer does.
    it("does NOT change existing stock from a product.updated delivery — WooCommerce's own order-driven decrement must not corrupt ASODITECH's physical stock", async () => {
      await seedIntegration();
      const warehouse = await prisma.warehouse.create({ data: { id: "wh-default", name: "Entrepôt principal", isDefault: true } });
      const product = await prisma.product.create({
        data: { name: "Produit webhook", sku: "WEBHOOK-SKU", price: 42, status: "ACTIF", source: "WOOCOMMERCE", externalId: "5001", trackInventory: true },
      });
      const item = await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 20, quantityReserved: 0 } });

      // WooCommerce reduced its own stock 20 -> 14 because an order was
      // placed, and fires product.updated as a side effect.
      const updateBody = productPayload({ stock_quantity: 14 });
      const response = await POST(
        request(updateBody, {
          "x-wc-webhook-signature": sign(updateBody),
          "x-wc-webhook-topic": "product.updated",
          "x-wc-webhook-delivery-id": "p3",
        })
      );
      expect(response.status).toBe(200);

      const after = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(after).toMatchObject({ quantityOnHand: 20, quantityReserved: 0 });
      expect(await prisma.inventoryMovement.count({ where: { inventoryItemId: item.id } })).toBe(0);
    });

    it("still updates the product's own fields (name/price/status) from product.updated, only stock is skipped", async () => {
      await seedIntegration();
      const warehouse = await prisma.warehouse.create({ data: { id: "wh-default", name: "Entrepôt principal", isDefault: true } });
      const product = await prisma.product.create({
        data: { name: "Ancien nom", sku: "WEBHOOK-SKU", price: 10, status: "ACTIF", source: "WOOCOMMERCE", externalId: "5001", trackInventory: true },
      });
      await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 20 } });

      const updateBody = productPayload({ name: "Nouveau nom", regular_price: "99.00", stock_quantity: 14 });
      await POST(request(updateBody, { "x-wc-webhook-signature": sign(updateBody), "x-wc-webhook-topic": "product.updated", "x-wc-webhook-delivery-id": "p3b" }));

      const updated = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
      expect(updated.name).toBe("Nouveau nom");
      expect(Number(updated.price)).toBe(99);
    });

    it("rejects a well-formed JSON body that doesn't match the expected product shape", async () => {
      await seedIntegration();
      const body = JSON.stringify({ not: "a product" });
      const response = await POST(
        request(body, { "x-wc-webhook-signature": sign(body), "x-wc-webhook-topic": "product.created", "x-wc-webhook-delivery-id": "p4" })
      );
      expect(response.status).toBe(400);
    });
  });
});

// The exact reported production scenario, end to end, through the real
// webhook route for both the order AND the product-stock side effect —
// see docs/adr/0030's addendum for the full root-cause writeup.
describe("root-cause regression: a NEW WooCommerce order survives its own order-driven product.updated stock webhook", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("NEW -> product.updated webhook (no-op) -> CONFIRM (reserves) -> CANCEL (releases) — physical stock never corrupted", async () => {
    await seedIntegration();
    const warehouse = await prisma.warehouse.create({ data: { id: "wh-default", name: "Entrepôt principal", isDefault: true } });
    const product = await prisma.product.create({
      data: { name: "Produit simple 01", sku: "SKU-501", price: 50, status: "ACTIF", source: "WOOCOMMERCE", externalId: "501", trackInventory: true },
    });
    const item = await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 20, quantityReserved: 0 } });

    // 1. The NEW WooCommerce order (qty 6) is imported.
    const orderBody = orderPayload({
      status: "pending",
      line_items: [{ id: 1, name: "Produit simple 01", product_id: 501, sku: "SKU-501", quantity: 6, price: "50.00", subtotal: "300.00", total: "300.00" }],
    });
    const orderResponse = await POST(
      request(orderBody, { "x-wc-webhook-signature": sign(orderBody), "x-wc-webhook-topic": "order.created", "x-wc-webhook-delivery-id": "prod-order" })
    );
    expect(orderResponse.status).toBe(200);
    const order = await prisma.order.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "7001" } });
    expect(order.status).toBe("NOUVELLE");

    let stock = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(stock).toMatchObject({ quantityOnHand: 20, quantityReserved: 0 }); // available = 20

    // 2. WooCommerce auto-decremented its OWN stock for that same order
    // (20 -> 14, "Manage stock" behaviour) and fires product.updated as a
    // side effect — exactly the trigger behind the production incident.
    const stockUpdateBody = productPayload({ id: 501, sku: "SKU-501", stock_quantity: 14 });
    const stockResponse = await POST(
      request(stockUpdateBody, { "x-wc-webhook-signature": sign(stockUpdateBody), "x-wc-webhook-topic": "product.updated", "x-wc-webhook-delivery-id": "prod-stock-update" })
    );
    expect(stockResponse.status).toBe(200);

    stock = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(stock).toMatchObject({ quantityOnHand: 20, quantityReserved: 0 }); // untouched — the fix
    expect(await prisma.inventoryMovement.count({ where: { inventoryItemId: item.id } })).toBe(0);

    // 3. A human confirms the order inside ASODITECH — THIS is what reserves.
    await loginAsTestUser({ role: "MANAGER" });
    const confirmResult = await updateOrderStatusAction(formData({ id: order.id, status: "CONFIRMEE" }));
    expect(confirmResult.ok).toBe(true);

    stock = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(stock).toMatchObject({ quantityOnHand: 20, quantityReserved: 6 }); // available = 14
    let movements = await prisma.inventoryMovement.findMany({ where: { inventoryItemId: item.id }, orderBy: { createdAt: "asc" } });
    expect(movements.map((m) => m.type)).toEqual(["RESERVATION"]);

    // 4. Cancel before shipment — releases the reservation, physical untouched.
    const cancelResult = await cancelOrderAction(formData({ id: order.id, reason: "" }));
    expect(cancelResult.ok).toBe(true);

    stock = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(stock).toMatchObject({ quantityOnHand: 20, quantityReserved: 0 }); // available = 20 again
    movements = await prisma.inventoryMovement.findMany({ where: { inventoryItemId: item.id }, orderBy: { createdAt: "asc" } });
    expect(movements.map((m) => m.type)).toEqual(["RESERVATION", "LIBERATION"]);
  });

  it("is idempotent: a repeated product.updated delivery for the same order-driven decrement never progressively corrupts stock", async () => {
    await seedIntegration();
    const warehouse = await prisma.warehouse.create({ data: { id: "wh-default", name: "Entrepôt principal", isDefault: true } });
    const product = await prisma.product.create({
      data: { name: "Produit simple 01", sku: "SKU-501", price: 50, status: "ACTIF", source: "WOOCOMMERCE", externalId: "501", trackInventory: true },
    });
    const item = await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 20 } });

    for (const deliveryId of ["retry-1", "retry-2", "retry-3"]) {
      const body = productPayload({ id: 501, sku: "SKU-501", stock_quantity: 14 });
      const response = await POST(request(body, { "x-wc-webhook-signature": sign(body), "x-wc-webhook-topic": "product.updated", "x-wc-webhook-delivery-id": deliveryId }));
      expect(response.status).toBe(200);
    }

    const stock = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(stock).toMatchObject({ quantityOnHand: 20, quantityReserved: 0 }); // never 26, never 14, never drifting
    expect(await prisma.inventoryMovement.count({ where: { inventoryItemId: item.id } })).toBe(0);
  });
});
