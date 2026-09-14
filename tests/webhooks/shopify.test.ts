import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import { POST } from "@/app/api/webhooks/shopify/route";
import { updateOrderStatusAction, reopenOrderAction } from "@/actions/orders";
import { resetDb } from "../helpers/db";
import { createTestUser, loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { installFakeShopifyServer, emptyFakeShopifyStore, FAKE_ACCESS_TOKEN, type FakeShopifyState } from "../helpers/fake-shopify";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const WEBHOOK_SECRET = "test-shopify-client-secret";

async function seedIntegration(configOverrides: Record<string, unknown> = {}) {
  return prisma.integration.create({
    data: {
      provider: "SHOPIFY",
      status: "CONNECTE",
      config: { shopDomain: "https://boutique-test.myshopify.com", ...configOverrides },
      credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: FAKE_ACCESS_TOKEN, apiSecret: WEBHOOK_SECRET })),
    },
  });
}

function sign(body: string, secret = WEBHOOK_SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

/** A second tenant with its own SHOPIFY integration and its own webhook
 * secret — provider is no longer globally unique (Phase 3, docs/adr/0025). */
async function seedTenantBIntegration(secret: string) {
  const TENANT_B = "tenant-b-shopify-webhook";
  await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
  const integration = await prismaBase.integration.create({
    data: {
      tenantId: TENANT_B,
      provider: "SHOPIFY",
      status: "CONNECTE",
      config: { shopDomain: "https://tenant-b.myshopify.com" },
      credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: FAKE_ACCESS_TOKEN, apiSecret: secret })),
    },
  });
  return { tenantId: TENANT_B, integration };
}

function orderCreatePayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ id: 7001, ...overrides });
}

function refundCreatePayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ id: 1, order_id: 7001, ...overrides });
}

function request(body: string, headers: Record<string, string>): Request {
  return new Request("https://app.example/api/webhooks/shopify", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("POST /api/webhooks/shopify", () => {
  let state: FakeShopifyState;

  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
    state = emptyFakeShopifyStore();
    installFakeShopifyServer(state);
    state.orders = [
      {
        id: "gid://shopify/Order/7001",
        name: "#7001",
        createdAt: "2026-01-20T10:00:00Z",
        displayFinancialStatus: "PENDING",
        displayFulfillmentStatus: "UNFULFILLED",
        email: "webhook@example.com",
        total: 50,
        subtotal: 50,
        lineItems: [{ id: "gid://shopify/LineItem/1", title: "Produit test", sku: "SKU-X", quantity: 1, unitPrice: 50, discountedTotal: 50, originalTotal: 50 }],
      },
    ];
  });

  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
    vi.unstubAllGlobals();
  });

  it("returns 404 when no Shopify integration is configured", async () => {
    const body = orderCreatePayload();
    const response = await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/create", "x-shopify-webhook-id": "d1" }));
    expect(response.status).toBe(404);
  });

  it("processes a validly signed orders/create delivery by re-fetching and importing the order", async () => {
    await seedIntegration();
    const staff = await createTestUser({ role: "CONFIRMATION" }); // holds orders.view
    const body = orderCreatePayload();
    const response = await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/create", "x-shopify-webhook-id": "d1" }));
    expect(response.status).toBe(200);

    const order = await prisma.order.findFirstOrThrow({ where: { source: "SHOPIFY", externalId: "gid://shopify/Order/7001" } });
    expect(Number(order.total)).toBe(50);

    const event = await prisma.webhookEvent.findFirstOrThrow({ where: { deliveryId: "d1" } });
    expect(event.status).toBe("TRAITE");

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "integration.webhook_received" } });
    expect(audit).toBeTruthy();

    // docs/adr/0016-notifications.md — new wiring this phase.
    const notification = await prisma.notification.findFirstOrThrow({ where: { userId: staff.id } });
    expect(notification.type).toBe("NOUVELLE_COMMANDE");
  });

  // docs/adr/0030's 2026-09-13 addendum: this is now the DEFAULT behavior
  // (config unset, or forceNouvelleOnImport explicitly true), not an
  // opt-in — a first-time paid/unfulfilled order never auto-lands as
  // Confirmée. Only CONFIRMATION inside ASODITECH reserves stock.
  it("a first-time import lands as NOUVELLE by default, even for a paid/unfulfilled order (config unset)", async () => {
    await seedIntegration();
    state.orders[0].displayFinancialStatus = "PAID";
    const body = orderCreatePayload();
    const response = await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/create", "x-shopify-webhook-id": "d-default-nouvelle" }));
    expect(response.status).toBe(200);

    const order = await prisma.order.findFirstOrThrow({ where: { source: "SHOPIFY", externalId: "gid://shopify/Order/7001" } });
    expect(order.status).toBe("NOUVELLE");

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "order.created", entityId: order.id } });
    expect((audit.metadata as Record<string, unknown>).forcedNouvelleFromConfirmee).toBe(true);
  });

  it("forces a first-time import to NOUVELLE when forceNouvelleOnImport is explicitly true, even for a paid/unfulfilled order", async () => {
    await seedIntegration({ forceNouvelleOnImport: true });
    state.orders[0].displayFinancialStatus = "PAID";
    const body = orderCreatePayload();
    const response = await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/create", "x-shopify-webhook-id": "d-force-nouvelle" }));
    expect(response.status).toBe(200);

    const order = await prisma.order.findFirstOrThrow({ where: { source: "SHOPIFY", externalId: "gid://shopify/Order/7001" } });
    expect(order.status).toBe("NOUVELLE");

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "order.created", entityId: order.id } });
    expect((audit.metadata as Record<string, unknown>).forcedNouvelleFromConfirmee).toBe(true);
  });

  it("trusts Shopify's own status when forceNouvelleOnImport is explicitly disabled (opt-out)", async () => {
    await seedIntegration({ forceNouvelleOnImport: false });
    state.orders[0].displayFinancialStatus = "PAID";
    const body = orderCreatePayload();
    const response = await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/create", "x-shopify-webhook-id": "d-no-force" }));
    expect(response.status).toBe(200);

    const order = await prisma.order.findFirstOrThrow({ where: { source: "SHOPIFY", externalId: "gid://shopify/Order/7001" } });
    expect(order.status).toBe("CONFIRMEE");
  });

  // 2026-09-13 fix — mirrors WooCommerce's identical regression test.
  // orders/create lands the order as NOUVELLE (PENDING/UNFULFILLED); Shopify
  // then marks it PAID and fires orders/updated. The OLD updateExistingOrder
  // always applied the store's real status once the order already existed,
  // silently promoting NOUVELLE -> CONFIRMEE. Now blocked, same as first import.
  it("a later webhook update reporting PAID does NOT silently promote an already-NOUVELLE order to CONFIRMEE", async () => {
    await seedIntegration(); // default: force-Nouvelle on
    const body = orderCreatePayload();
    const createdResponse = await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/create", "x-shopify-webhook-id": "d-created-pending" }));
    expect(createdResponse.status).toBe(200);
    let order = await prisma.order.findFirstOrThrow({ where: { source: "SHOPIFY", externalId: "gid://shopify/Order/7001" } });
    expect(order.status).toBe("NOUVELLE");

    state.orders[0].displayFinancialStatus = "PAID";
    const updatedResponse = await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/updated", "x-shopify-webhook-id": "d-updated-paid" }));
    expect(updatedResponse.status).toBe(200);

    order = await prisma.order.findFirstOrThrow({ where: { source: "SHOPIFY", externalId: "gid://shopify/Order/7001" } });
    expect(order.status).toBe("NOUVELLE"); // still requires a human confirmation inside ASODITECH
  });

  it("with forceNouvelleOnImport explicitly disabled, a later webhook update DOES apply the real status (opt-out honored on update too)", async () => {
    await seedIntegration({ forceNouvelleOnImport: false });
    const body = orderCreatePayload();
    await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/create", "x-shopify-webhook-id": "d-created-pending-2" }));
    let order = await prisma.order.findFirstOrThrow({ where: { source: "SHOPIFY", externalId: "gid://shopify/Order/7001" } });
    expect(order.status).toBe("NOUVELLE"); // PENDING always maps to NOUVELLE regardless of the setting

    state.orders[0].displayFinancialStatus = "PAID";
    await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/updated", "x-shopify-webhook-id": "d-updated-paid-2" }));
    order = await prisma.order.findFirstOrThrow({ where: { source: "SHOPIFY", externalId: "gid://shopify/Order/7001" } });
    expect(order.status).toBe("CONFIRMEE");
  });

  it("rejects an invalid signature with 401 and imports nothing", async () => {
    await seedIntegration();
    const body = orderCreatePayload();
    const response = await POST(request(body, { "x-shopify-hmac-sha256": sign(body, "wrong-secret"), "x-shopify-topic": "orders/create", "x-shopify-webhook-id": "d2" }));
    expect(response.status).toBe(401);

    const order = await prisma.order.findFirst({ where: { source: "SHOPIFY", externalId: "gid://shopify/Order/7001" } });
    expect(order).toBeNull();

    const rejected = await prisma.auditEvent.findFirstOrThrow({ where: { action: "integration.webhook_rejected" } });
    expect(rejected).toBeTruthy();
  });

  it("rejects a missing signature header with 401", async () => {
    await seedIntegration();
    const body = orderCreatePayload();
    const response = await POST(request(body, { "x-shopify-topic": "orders/create", "x-shopify-webhook-id": "d3" }));
    expect(response.status).toBe(401);
  });

  // Phase 3 (docs/adr/0025): provider is no longer globally unique, so the
  // tenant is resolved by matching the signature against every SHOPIFY
  // integration across every tenant. Uses products/delete (handled
  // straight from the webhook body, no GraphQL re-fetch) to keep the fake
  // Shopify server out of it.
  it("resolves the correct tenant among two Shopify integrations by signature", async () => {
    await seedIntegration(); // tenant A
    const TENANT_B_SECRET = "tenant-b-secret";
    const { tenantId: TENANT_B } = await seedTenantBIntegration(TENANT_B_SECRET);

    const gid = "gid://shopify/Product/9600";
    const productB = await prismaBase.product.create({
      data: { name: "B product", sku: "SH-B-1", price: 100, status: "ACTIF", source: "SHOPIFY", externalId: gid, tenantId: TENANT_B },
    });

    const body = JSON.stringify({ id: 9600 });
    const response = await POST(
      request(body, {
        "x-shopify-hmac-sha256": sign(body, TENANT_B_SECRET),
        "x-shopify-topic": "products/delete",
        "x-shopify-webhook-id": "d-tenant-b",
      })
    );
    expect(response.status).toBe(200);

    const after = await prismaBase.product.findUniqueOrThrow({ where: { id: productB.id } });
    expect(after.status).toBe("ARCHIVE");

    const event = await prismaBase.webhookEvent.findFirstOrThrow({ where: { deliveryId: "d-tenant-b" } });
    expect(event.tenantId).toBe(TENANT_B);
  });

  it("a signature that matches no tenant's integration is rejected with 401, attributed to no specific integration", async () => {
    await seedIntegration();
    await seedTenantBIntegration("tenant-b-secret");

    const body = JSON.stringify({ id: 9601 });
    const response = await POST(
      request(body, {
        "x-shopify-hmac-sha256": sign(body, "some-other-secret"),
        "x-shopify-topic": "products/delete",
        "x-shopify-webhook-id": "d-nobody",
      })
    );
    expect(response.status).toBe(401);

    const rejected = await prismaBase.auditEvent.findFirstOrThrow({
      where: { action: "integration.webhook_rejected", entityId: "unknown" },
    });
    expect(rejected).toBeTruthy();
  });

  it("rejects a request with no delivery id header", async () => {
    await seedIntegration();
    const body = orderCreatePayload();
    const response = await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/create" }));
    expect(response.status).toBe(400);
  });

  it("is idempotent under a replayed (duplicate) delivery id", async () => {
    await seedIntegration();
    const body = orderCreatePayload();
    const headers = { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/create", "x-shopify-webhook-id": "d4" };

    const first = await POST(request(body, headers));
    expect(first.status).toBe(200);
    const second = await POST(request(body, headers));
    expect(second.status).toBe(200);

    const orders = await prisma.order.findMany({ where: { source: "SHOPIFY", externalId: "gid://shopify/Order/7001" } });
    expect(orders).toHaveLength(1);
    const events = await prisma.webhookEvent.findMany({ where: { deliveryId: "d4" } });
    expect(events).toHaveLength(1);
  });

  it("handles concurrent duplicate deliveries without creating two orders", async () => {
    await seedIntegration();
    const body = orderCreatePayload();
    const headers = { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/create", "x-shopify-webhook-id": "d-concurrent" };

    const [a, b] = await Promise.all([POST(request(body, headers)), POST(request(body, headers))]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const orders = await prisma.order.findMany({ where: { source: "SHOPIFY", externalId: "gid://shopify/Order/7001" } });
    expect(orders).toHaveLength(1);
  });

  it("acknowledges (200) but ignores an unsupported topic without importing anything", async () => {
    await seedIntegration();
    const body = orderCreatePayload();
    const response = await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "customers/create", "x-shopify-webhook-id": "d5" }));
    expect(response.status).toBe(200);

    const order = await prisma.order.findFirst({ where: { source: "SHOPIFY", externalId: "gid://shopify/Order/7001" } });
    expect(order).toBeNull();

    const event = await prisma.webhookEvent.findFirstOrThrow({ where: { deliveryId: "d5" } });
    expect(event.status).toBe("IGNORE");
  });

  it("archives a product on a products/delete delivery", async () => {
    await seedIntegration();
    const gid = "gid://shopify/Product/9500";
    const product = await prisma.product.create({
      data: { name: "Vieux", sku: "SH-DEL-1", price: 100, status: "ACTIF", source: "SHOPIFY", externalId: gid },
    });
    const body = JSON.stringify({ id: 9500 });
    const response = await POST(
      request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "products/delete", "x-shopify-webhook-id": "d-del" })
    );
    expect(response.status).toBe(200);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.status).toBe("ARCHIVE");
  });

  it("rejects a malformed (non-JSON) body with 400", async () => {
    await seedIntegration();
    const body = "not json at all";
    const response = await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/create", "x-shopify-webhook-id": "d6" }));
    expect(response.status).toBe(400);
  });

  it("rejects a well-formed JSON body missing the required id field", async () => {
    await seedIntegration();
    const body = JSON.stringify({ not: "an order" });
    const response = await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/create", "x-shopify-webhook-id": "d7" }));
    expect(response.status).toBe(400);
  });

  it("processes orders/updated and orders/cancelled the same way (re-fetch by id)", async () => {
    await seedIntegration();
    state.orders[0].displayFulfillmentStatus = "FULFILLED";
    state.orders[0].displayFinancialStatus = "PAID";
    const body = orderCreatePayload();
    const response = await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/updated", "x-shopify-webhook-id": "d8" }));
    expect(response.status).toBe(200);
    const order = await prisma.order.findFirstOrThrow({ where: { source: "SHOPIFY", externalId: "gid://shopify/Order/7001" } });
    expect(order.status).toBe("LIVREE");
  });

  it("resolves refunds/create by its order_id field, not its own refund id", async () => {
    await seedIntegration();
    state.orders[0].displayFinancialStatus = "REFUNDED";
    state.orders[0].refundedTotal = 50;
    state.orders[0].refunds = [{ id: "gid://shopify/Refund/1", createdAt: "2026-01-21T00:00:00Z", total: 50 }];

    const body = refundCreatePayload();
    const response = await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "refunds/create", "x-shopify-webhook-id": "d9" }));
    expect(response.status).toBe(200);

    const order = await prisma.order.findFirstOrThrow({ where: { source: "SHOPIFY", externalId: "gid://shopify/Order/7001" } });
    expect(order.paymentStatus).toBe("REMBOURSE");
    const refund = await prisma.refund.findFirstOrThrow({ where: { orderId: order.id } });
    expect(Number(refund.amount)).toBe(50);
  });

  describe("products/create, products/update, inventory_levels/update (real-time product + stock sync)", () => {
    beforeEach(() => {
      state.products = [
        {
          id: "gid://shopify/Product/9001",
          title: "Produit webhook",
          handle: "produit-webhook",
          status: "ACTIVE",
          variants: [
            {
              id: "gid://shopify/ProductVariant/9001",
              title: "Default Title",
              sku: "WEBHOOK-SKU",
              price: "42.00",
              inventoryItemId: "gid://shopify/InventoryItem/9001",
              tracked: true,
              levels: [{ locationId: "gid://shopify/Location/1", available: 8 }],
            },
          ],
        },
      ];
    });

    function productPayload(overrides: Record<string, unknown> = {}) {
      return JSON.stringify({ id: 9001, ...overrides });
    }

    it("imports a new product from a products/create delivery, reconciling its stock", async () => {
      await seedIntegration();
      const body = productPayload();
      const response = await POST(
        request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "products/create", "x-shopify-webhook-id": "pd1" })
      );
      expect(response.status).toBe(200);

      const product = await prisma.product.findFirstOrThrow({ where: { source: "SHOPIFY", externalId: "gid://shopify/Product/9001" } });
      expect(product.sku).toBe("WEBHOOK-SKU");
      expect(Number(product.price)).toBe(42);

      const event = await prisma.webhookEvent.findFirstOrThrow({ where: { deliveryId: "pd1" } });
      expect(event.status).toBe("TRAITE");
    });

    it("updates an existing product's name from a products/update delivery", async () => {
      await seedIntegration();
      await POST(
        request(productPayload(), { "x-shopify-hmac-sha256": sign(productPayload()), "x-shopify-topic": "products/create", "x-shopify-webhook-id": "pd2" })
      );

      state.products[0].title = "Produit renommé";
      const body = productPayload();
      const response = await POST(
        request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "products/update", "x-shopify-webhook-id": "pd3" })
      );
      expect(response.status).toBe(200);

      const product = await prisma.product.findFirstOrThrow({ where: { source: "SHOPIFY", externalId: "gid://shopify/Product/9001" } });
      expect(product.name).toBe("Produit renommé");
    });

    // docs/adr/0036-inventory-single-source-of-truth.md: InventoryItem is
    // ASODITECH's sole source of truth for local stock after onboarding —
    // an inventory_levels/update delivery is recorded (replay-protection/
    // observability) but must NEVER mutate quantityOnHand, no matter how
    // far it differs from what Shopify itself reports.
    it("accepts an inventory_levels/update delivery but NEVER mutates local stock", async () => {
      await seedIntegration();
      await prisma.warehouse.create({
        data: { name: "Entrepôt Shopify", source: "SHOPIFY", externalId: "gid://shopify/Location/1" },
      });
      // The product/variant must already be known locally (via the bulk
      // sync or a products/create webhook) before an inventory-only
      // webhook can be attributed to it.
      await POST(
        request(productPayload(), { "x-shopify-hmac-sha256": sign(productPayload()), "x-shopify-topic": "products/create", "x-shopify-webhook-id": "pd4" })
      );
      const product = await prisma.product.findFirstOrThrow({ where: { source: "SHOPIFY", externalId: "gid://shopify/Product/9001" } });
      const before = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
      expect(before.quantityOnHand).toBe(8);

      // The store reports a completely different number — must be ignored.
      const body = JSON.stringify({ inventory_item_id: 9001, location_id: 1, available: 5 });
      const response = await POST(
        request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "inventory_levels/update", "x-shopify-webhook-id": "pd5" })
      );
      expect(response.status).toBe(200);

      const after = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
      expect(after.quantityOnHand).toBe(8); // untouched
      expect(await prisma.inventoryMovement.count()).toBe(0);

      // Still recorded, for replay-protection/observability.
      const event = await prisma.webhookEvent.findFirstOrThrow({ where: { deliveryId: "pd5" } });
      expect(event.status).toBe("TRAITE");
    });

    it("acknowledges an inventory_levels/update delivery for a not-yet-known item without crashing or writing anything", async () => {
      await seedIntegration();
      const body = JSON.stringify({ inventory_item_id: 999999, location_id: 1, available: 5 });
      const response = await POST(
        request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "inventory_levels/update", "x-shopify-webhook-id": "pd6" })
      );
      expect(response.status).toBe(200);
      expect(await prisma.inventoryItem.count()).toBe(0);
    });
  });

  // docs/adr/0036-inventory-single-source-of-truth.md: only ASODITECH's own
  // EXPEDIEE transition may ever physically consume stock. A Shopify
  // fulfillment status that would otherwise map to EXPEDIEE must never
  // auto-apply locally — it must surface as a workflow-mismatch
  // notification instead.
  describe("a Shopify fulfillment status mapping to EXPEDIEE never auto-advances the local order (docs/adr/0036)", () => {
    async function importThenAdvanceToEnPreparation() {
      const body = orderCreatePayload();
      await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/create", "x-shopify-webhook-id": "wf1" }));
      const order = await prisma.order.findFirstOrThrow({ where: { source: "SHOPIFY", externalId: "gid://shopify/Order/7001" } });
      expect(order.status).toBe("NOUVELLE");

      await updateOrderStatusAction(formData({ id: order.id, status: "CONFIRMEE" }));
      await updateOrderStatusAction(formData({ id: order.id, status: "EN_PREPARATION" }));
      return order.id;
    }

    it("IN_PROGRESS fulfillment status is blocked, creates a workflow-mismatch notification, and consumes no stock", async () => {
      await seedIntegration();
      const user = await loginAsTestUser({ role: "MANAGER" });
      const orderId = await importThenAdvanceToEnPreparation();
      const movementsBefore = await prisma.inventoryMovement.count({ where: { orderId } });

      state.orders[0].displayFinancialStatus = "PAID";
      state.orders[0].displayFulfillmentStatus = "IN_PROGRESS";
      const body = orderCreatePayload();
      const response = await POST(
        request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/updated", "x-shopify-webhook-id": "wf2" })
      );
      expect(response.status).toBe(200);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe("EN_PREPARATION"); // NOT auto-advanced to EXPEDIEE
      expect(order.shippedAt).toBeNull();
      expect(await prisma.inventoryMovement.count({ where: { orderId } })).toBe(movementsBefore); // no stock movement at all

      const notification = await prisma.notification.findFirstOrThrow({
        where: { type: "INCOHERENCE_WORKFLOW", entityType: "Order", entityId: orderId },
      });
      expect(notification.userId).toBe(user.id);
    });

    it("does not create a duplicate mismatch notification on a repeated delivery", async () => {
      await seedIntegration();
      await loginAsTestUser({ role: "MANAGER" });
      const orderId = await importThenAdvanceToEnPreparation();

      state.orders[0].displayFinancialStatus = "PAID";
      state.orders[0].displayFulfillmentStatus = "PARTIALLY_FULFILLED";
      const body = orderCreatePayload();
      await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/updated", "x-shopify-webhook-id": "wf3" }));
      await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/updated", "x-shopify-webhook-id": "wf4" }));

      const count = await prisma.notification.count({
        where: { type: "INCOHERENCE_WORKFLOW", entityType: "Order", entityId: orderId },
      });
      expect(count).toBe(1);
    });

    it("resolves the mismatch notification once the local workflow reaches EXPEDIEE itself", async () => {
      await seedIntegration();
      await loginAsTestUser({ role: "MANAGER" });
      const orderId = await importThenAdvanceToEnPreparation();

      state.orders[0].displayFinancialStatus = "PAID";
      state.orders[0].displayFulfillmentStatus = "IN_PROGRESS";
      const body = orderCreatePayload();
      await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/updated", "x-shopify-webhook-id": "wf5" }));
      expect(
        await prisma.notification.count({ where: { type: "INCOHERENCE_WORKFLOW", entityType: "Order", entityId: orderId } })
      ).toBe(1);

      const shipped = await updateOrderStatusAction(formData({ id: orderId, status: "EXPEDIEE" }));
      expect(shipped.ok).toBe(true);

      expect(
        await prisma.notification.count({ where: { type: "INCOHERENCE_WORKFLOW", entityType: "Order", entityId: orderId } })
      ).toBe(0);
    });
  });

  it("does not persist the raw webhook payload or any order content — only id/topic/status metadata", async () => {
    await seedIntegration();
    const body = orderCreatePayload();
    await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/create", "x-shopify-webhook-id": "d10" }));

    const event = await prisma.webhookEvent.findFirstOrThrow({ where: { deliveryId: "d10" } });
    expect(Object.keys(event).sort()).toEqual(
      ["id", "tenantId", "integrationId", "provider", "deliveryId", "topic", "resourceId", "status", "receivedAt"].sort()
    );
    const raw = JSON.stringify(event);
    expect(raw).not.toContain("webhook@example.com");
    expect(raw).not.toContain("Produit test");
    expect(event.resourceId).toBe("gid://shopify/Order/7001");
  });
});

// Mirrors WooCommerce's identical regression (docs/adr/0030's addendum):
// a Shopify order manually confirmed inside ASODITECH can be demoted back
// to ANNULEE by the store's own status (a stale/retried webhook) — before
// this fix, that never released the reservation a human had taken.
describe("root-cause regression: a webhook demoting a CONFIRMEE/EN_PREPARATION order back to ANNULEE releases the reservation", () => {
  let state: FakeShopifyState;

  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
    state = emptyFakeShopifyStore();
    installFakeShopifyServer(state);
    state.orders = [
      {
        id: "gid://shopify/Order/7001",
        name: "#7001",
        createdAt: "2026-01-20T10:00:00Z",
        displayFinancialStatus: "PENDING",
        displayFulfillmentStatus: "UNFULFILLED",
        email: "webhook@example.com",
        total: 250,
        subtotal: 250,
        lineItems: [{ id: "gid://shopify/LineItem/1", title: "Produit S", sku: "SKU-S", quantity: 5, unitPrice: 50, discountedTotal: 250, originalTotal: 250, productId: "gid://shopify/Product/501" }],
      },
    ];
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
    vi.unstubAllGlobals();
  });

  async function seedConfirmedOrder() {
    await seedIntegration();
    const warehouse = await prisma.warehouse.create({ data: { id: "wh-default", name: "Entrepôt principal", isDefault: true } });
    const product = await prisma.product.create({
      data: { name: "Produit S", sku: "SKU-S", price: 50, status: "ACTIF", source: "SHOPIFY", externalId: "gid://shopify/Product/501", trackInventory: true },
    });
    const item = await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 15, quantityReserved: 0 } });

    const body = orderCreatePayload();
    await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/create", "x-shopify-webhook-id": "seed-created" }));
    const order = await prisma.order.findFirstOrThrow({ where: { source: "SHOPIFY", externalId: "gid://shopify/Order/7001" } });

    await loginAsTestUser({ role: "MANAGER" });
    await updateOrderStatusAction(formData({ id: order.id, status: "CONFIRMEE" }));

    return { item, order };
  }

  it("a stale 'cancelled' webhook after a manual CONFIRMEE releases the reservation instead of leaving it stuck", async () => {
    const { item, order } = await seedConfirmedOrder();
    let stock = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(stock).toMatchObject({ quantityOnHand: 15, quantityReserved: 5 });

    state.orders[0].cancelledAt = "2026-01-21T10:00:00Z";
    const body = orderCreatePayload();
    const response = await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/updated", "x-shopify-webhook-id": "stale-cancel" }));
    expect(response.status).toBe(200);

    const afterOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(afterOrder.status).toBe("ANNULEE");
    stock = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(stock).toMatchObject({ quantityOnHand: 15, quantityReserved: 0 }); // released, not stuck at 5
    const movements = await prisma.inventoryMovement.findMany({ where: { inventoryItemId: item.id }, orderBy: { createdAt: "asc" } });
    expect(movements.map((m) => m.type)).toEqual(["RESERVATION", "LIBERATION"]);
  });

  it("reopening and re-confirming after a webhook-driven cancellation reserves exactly 5, never 10", async () => {
    const { item, order } = await seedConfirmedOrder();

    state.orders[0].cancelledAt = "2026-01-21T10:00:00Z";
    const body = orderCreatePayload();
    await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/updated", "x-shopify-webhook-id": "stale-cancel-2" }));

    await reopenOrderAction(formData({ id: order.id }));
    await updateOrderStatusAction(formData({ id: order.id, status: "CONFIRMEE" }));

    const stock = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(stock).toMatchObject({ quantityOnHand: 15, quantityReserved: 5 }); // exactly 5 — NOT 10
    const movements = await prisma.inventoryMovement.findMany({ where: { inventoryItemId: item.id }, orderBy: { createdAt: "asc" } });
    expect(movements.map((m) => m.type)).toEqual(["RESERVATION", "LIBERATION", "RESERVATION"]);
  });
});
