import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import { POST } from "@/app/api/webhooks/woocommerce/route";
import { resetDb } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

const WEBHOOK_SECRET = "test-webhook-secret";

async function seedIntegration() {
  return prisma.integration.create({
    data: {
      provider: "WOOCOMMERCE",
      status: "CONNECTE",
      config: { siteUrl: "https://example.com" },
      credentialsEncrypted: encryptSecret(
        JSON.stringify({ apiKey: "ck_x", apiSecret: "cs_x", webhookSecret: WEBHOOK_SECRET })
      ),
    },
  });
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
    const staff = await createTestUser({ role: "SALES" }); // holds orders.view
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
      request(body, { "x-wc-webhook-signature": sign(body), "x-wc-webhook-topic": "product.deleted", "x-wc-webhook-delivery-id": "d5" })
    );
    expect(response.status).toBe(200);

    const order = await prisma.order.findFirst({ where: { source: "WOOCOMMERCE", externalId: "7001" } });
    expect(order).toBeNull();

    const event = await prisma.webhookEvent.findFirstOrThrow({ where: { deliveryId: "d5" } });
    expect(event.status).toBe("IGNORE");
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
});
