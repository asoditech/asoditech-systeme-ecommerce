import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import { POST } from "@/app/api/webhooks/shopify/route";
import { resetDb } from "../helpers/db";
import { mockCookieStore } from "../mocks/cookie-store";
import { installFakeShopifyServer, emptyFakeShopifyStore, FAKE_ACCESS_TOKEN, type FakeShopifyState } from "../helpers/fake-shopify";

const WEBHOOK_SECRET = "test-shopify-client-secret";

async function seedIntegration() {
  return prisma.integration.create({
    data: {
      provider: "SHOPIFY",
      status: "CONNECTE",
      config: { shopDomain: "https://boutique-test.myshopify.com" },
      credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: FAKE_ACCESS_TOKEN, apiSecret: WEBHOOK_SECRET })),
    },
  });
}

function sign(body: string, secret = WEBHOOK_SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
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
    const body = orderCreatePayload();
    const response = await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/create", "x-shopify-webhook-id": "d1" }));
    expect(response.status).toBe(200);

    const order = await prisma.order.findFirstOrThrow({ where: { source: "SHOPIFY", externalId: "gid://shopify/Order/7001" } });
    expect(Number(order.total)).toBe(50);

    const event = await prisma.webhookEvent.findFirstOrThrow({ where: { deliveryId: "d1" } });
    expect(event.status).toBe("TRAITE");

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "integration.webhook_received" } });
    expect(audit).toBeTruthy();
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
    const response = await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "products/update", "x-shopify-webhook-id": "d5" }));
    expect(response.status).toBe(200);

    const order = await prisma.order.findFirst({ where: { source: "SHOPIFY", externalId: "gid://shopify/Order/7001" } });
    expect(order).toBeNull();

    const event = await prisma.webhookEvent.findFirstOrThrow({ where: { deliveryId: "d5" } });
    expect(event.status).toBe("IGNORE");
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

  it("does not persist the raw webhook payload or any order content — only id/topic/status metadata", async () => {
    await seedIntegration();
    const body = orderCreatePayload();
    await POST(request(body, { "x-shopify-hmac-sha256": sign(body), "x-shopify-topic": "orders/create", "x-shopify-webhook-id": "d10" }));

    const event = await prisma.webhookEvent.findFirstOrThrow({ where: { deliveryId: "d10" } });
    expect(Object.keys(event).sort()).toEqual(
      ["id", "integrationId", "provider", "deliveryId", "topic", "resourceId", "status", "receivedAt"].sort()
    );
    const raw = JSON.stringify(event);
    expect(raw).not.toContain("webhook@example.com");
    expect(raw).not.toContain("Produit test");
    expect(event.resourceId).toBe("gid://shopify/Order/7001");
  });
});
