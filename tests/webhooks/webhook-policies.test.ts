import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import { POST as wooPOST } from "@/app/api/webhooks/woocommerce/route";
import { POST as shopifyPOST } from "@/app/api/webhooks/shopify/route";
import { readWebhookBody, WEBHOOK_MAX_BODY_BYTES } from "@/lib/integrations/shared/webhook-body";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";
import { mockCookieStore } from "../mocks/cookie-store";
import { installFakeShopifyServer, emptyFakeShopifyStore, FAKE_ACCESS_TOKEN, type FakeShopifyState } from "../helpers/fake-shopify";

/**
 * Webhook policies shared by both receivers (owner decisions 2026-10-14,
 * docs/decisions/order-sync-open-decisions.md « Webhook policy choices »):
 * a 1 MiB body limit enforced before any parsing / signature work, suspended
 * companies never processed (recorded « SUSPENDU », acknowledged, never
 * replayed), permanent failures acknowledged. Local fakes only — no real
 * store's retry or disable behaviour is verified here.
 */

const WOO_SECRET = "policy-woo-secret";
const SHOP_SECRET = "policy-shopify-secret";
const MiB = WEBHOOK_MAX_BODY_BYTES;

const sign = (body: string, secret: string) => createHmac("sha256", secret).update(body, "utf8").digest("base64");

function wooOrderBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: 7001,
    number: "7001",
    status: "pending",
    currency: "MAD",
    date_created: "2026-01-20T10:00:00",
    date_paid: null,
    customer_id: 0,
    total: "50.00",
    payment_method: "cod",
    billing: { first_name: "Sara", last_name: "Amrani", email: "s@example.com", city: "Casablanca", country: "MA", address_1: "1 Rue" },
    shipping: {},
    line_items: [{ id: 1, name: "Produit", product_id: null, sku: "SKU-X", quantity: 1, price: "50.00", subtotal: "50.00", total: "50.00" }],
    refunds: [],
    ...overrides,
  });
}

/** `body` padded with JSON whitespace to exactly `bytes` UTF-8 bytes (still valid JSON, same meaning). */
function padTo(body: string, bytes: number): string {
  const size = Buffer.byteLength(body, "utf8");
  if (size > bytes) throw new Error("body already larger than the target size");
  return body + " ".repeat(bytes - size);
}

let shopifyState: FakeShopifyState;

const PROVIDERS = [
  {
    name: "WooCommerce",
    provider: "WOOCOMMERCE" as const,
    POST: wooPOST,
    secret: WOO_SECRET,
    async seed(tenantId?: string) {
      const db = tenantId ? prismaBase : prisma;
      return db.integration.create({
        data: {
          ...(tenantId ? { tenantId } : {}),
          provider: "WOOCOMMERCE",
          status: "CONNECTE",
          config: { siteUrl: "https://example.com" },
          credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: "ck", apiSecret: "cs", webhookSecret: tenantId ? `${WOO_SECRET}-${tenantId}` : WOO_SECRET })),
        },
      });
    },
    orderBody: () => wooOrderBody(),
    request(body: string, deliveryId: string, secret = WOO_SECRET, extra: Record<string, string> = {}) {
      return new Request("https://app.example/api/webhooks/woocommerce", {
        method: "POST",
        headers: { "content-type": "application/json", "x-wc-webhook-signature": sign(body, secret), "x-wc-webhook-topic": "order.created", "x-wc-webhook-delivery-id": deliveryId, ...extra },
        body,
      });
    },
  },
  {
    name: "Shopify",
    provider: "SHOPIFY" as const,
    POST: shopifyPOST,
    secret: SHOP_SECRET,
    async seed(tenantId?: string) {
      const db = tenantId ? prismaBase : prisma;
      return db.integration.create({
        data: {
          ...(tenantId ? { tenantId } : {}),
          provider: "SHOPIFY",
          status: "CONNECTE",
          config: { shopDomain: tenantId ? `https://${tenantId}.myshopify.com` : "https://boutique-test.myshopify.com" },
          credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: FAKE_ACCESS_TOKEN, apiSecret: tenantId ? `${SHOP_SECRET}-${tenantId}` : SHOP_SECRET })),
        },
      });
    },
    orderBody: () => JSON.stringify({ id: 7001 }),
    request(body: string, deliveryId: string, secret = SHOP_SECRET, extra: Record<string, string> = {}) {
      return new Request("https://app.example/api/webhooks/shopify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-shopify-hmac-sha256": sign(body, secret), "x-shopify-topic": "orders/create", "x-shopify-webhook-id": deliveryId, ...extra },
        body,
      });
    },
  },
];

// resetDb() keeps the default tenant row as it is: its status is restored here,
// so a suspension set by one test never leaks into the next.
const reactivateDefaultTenant = () => prismaBase.tenant.update({ where: { id: DEFAULT_TENANT_ID }, data: { status: "ACTIVE" } });

beforeEach(async () => {
  await resetDb();
  await reactivateDefaultTenant();
  mockCookieStore.clear();
  shopifyState = emptyFakeShopifyStore();
  installFakeShopifyServer(shopifyState);
  shopifyState.orders = [
    {
      id: "gid://shopify/Order/7001",
      name: "#7001",
      createdAt: "2026-01-20T10:00:00Z",
      displayFinancialStatus: "PENDING",
      displayFulfillmentStatus: "UNFULFILLED",
      email: "s@example.com",
      total: 50,
      subtotal: 50,
      lineItems: [{ id: "gid://shopify/LineItem/1", title: "Produit", sku: "SKU-X", quantity: 1, unitPrice: 50, discountedTotal: 50, originalTotal: 50 }],
    },
  ];
});
afterEach(async () => {
  await resetDb();
  await reactivateDefaultTenant();
  mockCookieStore.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("readWebhookBody — bounded read of the raw body (no full buffering of an oversized body)", () => {
  it("exactly the limit is accepted and decoded like Request.text(); one byte more is refused", async () => {
    const exact = "é".repeat(10) + "x".repeat(MiB - 20); // 10 two-byte chars + ASCII = exactly 1 MiB
    expect(Buffer.byteLength(exact, "utf8")).toBe(MiB);
    const ok = await readWebhookBody(new Request("https://x", { method: "POST", body: exact }));
    expect(ok.ok).toBe(true);
    const sameAsText = ok.ok && ok.text === (await new Request("https://x", { method: "POST", body: exact }).text());
    expect(sameAsText).toBe(true); // boolean: never a megabyte-string diff on failure
    const over = await readWebhookBody(new Request("https://x", { method: "POST", body: exact + "x" }));
    expect(over.ok ? "accepted" : over.status).toBe(413);
  });

  it("a declared Content-Length above the limit is refused WITHOUT reading the body", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024));
        if (pulled >= 4 * 1024) controller.close(); // finite (4 MiB), so a regression fails cleanly instead of exhausting memory
      },
    });
    const req = new Request("https://x", { method: "POST", body: stream, headers: { "content-length": String(MiB + 1) }, duplex: "half" } as RequestInit);
    const result = await readWebhookBody(req);
    expect(result.ok ? "accepted" : result.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(1); // the stream may prime one chunk; it is never drained
  });

  it("no Content-Length (chunked): reading stops and the stream is cancelled as soon as the limit is passed — never drained", async () => {
    const CHUNK = 64 * 1024;
    let delivered = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        delivered += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK).fill(32));
        if (delivered >= 4 * MiB) controller.close(); // a body 4× the limit (finite, so a regression fails cleanly)
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = new Request("https://x", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    const result = await readWebhookBody(req);
    expect(result.ok ? "accepted" : result.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(delivered).toBeLessThanOrEqual(MiB + 2 * CHUNK); // limit + at most the overflowing chunk (+ one prefetched)
  });
});

describe.each(PROVIDERS)("$name webhook — 1 MiB body limit", (p) => {
  it("a validly signed body of EXACTLY 1 MiB is accepted: the signature verifies over the exact raw bytes and the order is processed", async () => {
    await p.seed();
    const body = padTo(p.orderBody(), MiB);
    const response = await p.POST(p.request(body, "d-exact"));
    expect(response.status).toBe(200);
    expect((await prisma.webhookEvent.findFirstOrThrow({ where: { deliveryId: "d-exact" } })).status).toBe("TRAITE");
    expect(await prisma.order.count({ where: { source: p.provider } })).toBe(1);
  });

  it("1 MiB + 1 byte, even validly signed → 413: nothing parsed, nothing recorded, no order (no side effect)", async () => {
    await p.seed();
    const body = padTo(p.orderBody(), MiB) + " ";
    const response = await p.POST(p.request(body, "d-over"));
    expect(response.status).toBe(413);
    expect(await prismaBase.webhookEvent.count()).toBe(0);
    expect(await prismaBase.order.count()).toBe(0);
    expect(await prismaBase.auditEvent.count({ where: { entityType: "Order" } })).toBe(0);
  });

  it("an oversized body is refused before authentication: a wrong signature still gets 413, never a 401 probe", async () => {
    await p.seed();
    const body = padTo(p.orderBody(), MiB) + " ";
    const response = await p.POST(p.request(body, "d-over-bad", "not-the-secret"));
    expect(response.status).toBe(413);
    expect(await prismaBase.webhookEvent.count()).toBe(0);
  });

  it("a small body with a bad signature is still 401 (the limit does not weaken authentication)", async () => {
    await p.seed();
    const response = await p.POST(p.request(p.orderBody(), "d-bad", "not-the-secret"));
    expect(response.status).toBe(401);
    expect(await prismaBase.webhookEvent.count()).toBe(0);
    expect(await prismaBase.order.count()).toBe(0);
  });
});

describe.each(PROVIDERS)("$name webhook — suspended company", (p) => {
  it("authenticated delivery of a suspended company: 200, recorded once « SUSPENDU », nothing processed; reactivation does not replay it; a new delivery is processed", async () => {
    await p.seed();
    await prismaBase.tenant.update({ where: { id: DEFAULT_TENANT_ID }, data: { status: "SUSPENDED" } });

    const body = p.orderBody();
    expect((await p.POST(p.request(body, "d-susp"))).status).toBe(200);
    expect((await prisma.webhookEvent.findFirstOrThrow({ where: { deliveryId: "d-susp" } })).status).toBe("SUSPENDU");
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.customer.count()).toBe(0);
    // the same delivery retried while still suspended: still one row, nothing processed
    expect((await p.POST(p.request(body, "d-susp"))).status).toBe(200);
    expect(await prisma.webhookEvent.count({ where: { deliveryId: "d-susp" } })).toBe(1);

    await prismaBase.tenant.update({ where: { id: DEFAULT_TENANT_ID }, data: { status: "ACTIVE" } });
    // the ignored delivery replayed after reactivation: acknowledged, NOT processed
    expect((await p.POST(p.request(body, "d-susp"))).status).toBe(200);
    expect(await prisma.order.count()).toBe(0);
    expect((await prisma.webhookEvent.findFirstOrThrow({ where: { deliveryId: "d-susp" } })).status).toBe("SUSPENDU");
    // a new delivery after reactivation is processed normally
    expect((await p.POST(p.request(body, "d-after"))).status).toBe(200);
    expect(await prisma.order.count()).toBe(1);
  });

  it("a bad signature for a suspended company is still 401 and records nothing", async () => {
    await p.seed();
    await prismaBase.tenant.update({ where: { id: DEFAULT_TENANT_ID }, data: { status: "SUSPENDED" } });
    expect((await p.POST(p.request(p.orderBody(), "d-susp-bad", "not-the-secret"))).status).toBe(401);
    expect(await prismaBase.webhookEvent.count()).toBe(0);
  });

  it("tenant isolation: another, suspended company's delivery is recorded in ITS tenant only; this company's deliveries keep being processed", async () => {
    const B = "tenant-b-policies";
    await prismaBase.tenant.create({ data: { id: B, name: "B", slug: B, status: "SUSPENDED" } });
    await p.seed();
    const bIntegration = await p.seed(B);

    const bBody = p.orderBody();
    const bExtra: Record<string, string> = p.provider === "SHOPIFY" ? { "x-shopify-shop-domain": `${B}.myshopify.com` } : {};
    expect((await p.POST(p.request(bBody, "d-b", `${p.secret}-${B}`, bExtra))).status).toBe(200);
    expect(await prismaBase.webhookEvent.findFirstOrThrow({ where: { deliveryId: "d-b" } })).toMatchObject({ tenantId: B, integrationId: bIntegration.id, status: "SUSPENDU" });

    expect((await p.POST(p.request(p.orderBody(), "d-a"))).status).toBe(200);
    expect(await prismaBase.order.count({ where: { tenantId: DEFAULT_TENANT_ID } })).toBe(1);
    expect(await prismaBase.order.count({ where: { tenantId: B } })).toBe(0);
  });
});

describe("permanent failures are recorded ECHEC and acknowledged (200) — retrying cannot help", () => {
  it("WooCommerce: product.updated for a connection without usable API credentials → ECHEC + 200, nothing imported", async () => {
    await prisma.integration.create({
      data: {
        provider: "WOOCOMMERCE",
        status: "CONNECTE",
        config: { siteUrl: "https://example.com" },
        credentialsEncrypted: encryptSecret(JSON.stringify({ webhookSecret: WOO_SECRET })), // no apiKey / apiSecret
      },
    });
    const body = JSON.stringify({ id: 5001, name: "P", slug: "p", sku: "P-1", status: "publish", type: "simple", regular_price: "10.00", manage_stock: false, categories: [] });
    const response = await wooPOST(
      new Request("https://app.example/api/webhooks/woocommerce", {
        method: "POST",
        headers: { "x-wc-webhook-signature": sign(body, WOO_SECRET), "x-wc-webhook-topic": "product.updated", "x-wc-webhook-delivery-id": "d-nocreds" },
        body,
      })
    );
    expect(response.status).toBe(200);
    expect((await prisma.webhookEvent.findFirstOrThrow({ where: { deliveryId: "d-nocreds" } })).status).toBe("ECHEC");
    expect(await prisma.product.count()).toBe(0);
  });

  it("Shopify: orders/updated for an order Shopify no longer returns → ECHEC + 200, nothing created", async () => {
    await PROVIDERS[1].seed();
    const body = JSON.stringify({ id: 999999 });
    const response = await shopifyPOST(PROVIDERS[1].request(body, "d-gone"));
    expect(response.status).toBe(200);
    expect((await prisma.webhookEvent.findFirstOrThrow({ where: { deliveryId: "d-gone" } })).status).toBe("ECHEC");
    expect(await prisma.order.count()).toBe(0);
  });
});
