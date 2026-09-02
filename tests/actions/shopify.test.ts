import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";
import { connectIntegrationAction, disconnectIntegrationAction } from "@/actions/integrations";
import {
  testShopifyConnectionAction,
  syncShopifyProductsAction,
  syncShopifyOrdersAction,
  pushShopifyStockAction,
} from "@/actions/shopify";
import { importOrder } from "@/lib/integrations/shopify/sync";
import { resetDb } from "../helpers/db";
import { loginAsTestUser, createTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import {
  installFakeShopifyServer,
  emptyFakeShopifyStore,
  FAKE_SHOP_DOMAIN,
  FAKE_ACCESS_TOKEN,
  type FakeShopifyState,
} from "../helpers/fake-shopify";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function connectFakeStore() {
  const result = await connectIntegrationAction(formData({ provider: "SHOPIFY", siteUrl: FAKE_SHOP_DOMAIN, apiKey: FAKE_ACCESS_TOKEN, apiSecret: "" }));
  if (!result.ok) throw new Error(`setup failed: ${result.error}`);
  return result.data.id;
}

function futureIso(minutesFromNow = 5): string {
  return new Date(Date.now() + minutesFromNow * 60_000).toISOString();
}

describe("Shopify integration", () => {
  let state: FakeShopifyState;

  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
    state = emptyFakeShopifyStore();
    installFakeShopifyServer(state);
  });

  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
    vi.unstubAllGlobals();
  });

  describe("connectIntegrationAction — Shopify", () => {
    it("rejects a caller without integrations.manage permission", async () => {
      await loginAsTestUser({ role: "SALES" });
      await expect(
        connectIntegrationAction(formData({ provider: "SHOPIFY", siteUrl: FAKE_SHOP_DOMAIN, apiKey: "x", apiSecret: "" }))
      ).rejects.toThrow(/non autorisé/i);
    });

    it("rejects a non-myshopify.com domain", async () => {
      await loginAsTestUser({ role: "ADMIN" });
      const result = await connectIntegrationAction(formData({ provider: "SHOPIFY", siteUrl: "https://www.maboutique.com", apiKey: "x", apiSecret: "" }));
      expect(result.ok).toBe(false);
      const integration = await prisma.integration.findUnique({ where: { provider: "SHOPIFY" } });
      expect(integration).toBeNull();
    });

    it("requires an access token", async () => {
      await loginAsTestUser({ role: "ADMIN" });
      const result = await connectIntegrationAction(formData({ provider: "SHOPIFY", siteUrl: FAKE_SHOP_DOMAIN, apiKey: "", apiSecret: "" }));
      expect(result.ok).toBe(false);
    });

    it("allows an empty webhook secret (apiSecret) — it's optional", async () => {
      await loginAsTestUser({ role: "ADMIN" });
      const result = await connectIntegrationAction(formData({ provider: "SHOPIFY", siteUrl: FAKE_SHOP_DOMAIN, apiKey: FAKE_ACCESS_TOKEN, apiSecret: "" }));
      expect(result.ok).toBe(true);
    });

    it("saves credentials encrypted (never plaintext) and lands on CONFIGURE, not CONNECTE", async () => {
      await loginAsTestUser({ role: "ADMIN" });
      const id = await connectFakeStore();

      const integration = await prisma.integration.findUniqueOrThrow({ where: { id } });
      expect(integration.status).toBe("CONFIGURE");
      expect(integration.credentialsEncrypted).not.toBeNull();
      expect(integration.credentialsEncrypted).not.toContain(FAKE_ACCESS_TOKEN);

      const decrypted = JSON.parse(decryptSecret(integration.credentialsEncrypted!));
      expect(decrypted.apiKey).toBe(FAKE_ACCESS_TOKEN);
    });
  });

  describe("testShopifyConnectionAction", () => {
    it("rejects a caller without integrations.manage permission", async () => {
      await loginAsTestUser({ role: "WAREHOUSE" });
      await expect(testShopifyConnectionAction()).rejects.toThrow(/non autorisé/i);
    });

    it("returns an error when nothing is configured yet", async () => {
      await loginAsTestUser({ role: "ADMIN" });
      const result = await testShopifyConnectionAction();
      expect(result.ok).toBe(false);
    });

    it("advances status to CONNECTE only after a real successful authenticated request", async () => {
      await loginAsTestUser({ role: "ADMIN" });
      await connectFakeStore();

      const result = await testShopifyConnectionAction();
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.status).toBe("CONNECTE");

      const integration = await prisma.integration.findUniqueOrThrow({ where: { provider: "SHOPIFY" } });
      expect(integration.status).toBe("CONNECTE");
      expect(integration.lastConnectionCheckAt).not.toBeNull();
    });

    it("sets status to ERREUR (never CONNECTE) on invalid credentials, without leaking the token", async () => {
      const actor = await loginAsTestUser({ role: "ADMIN" });
      const teammate = await createTestUser({ role: "ADMIN" }); // also holds integrations.view
      await connectIntegrationAction(formData({ provider: "SHOPIFY", siteUrl: FAKE_SHOP_DOMAIN, apiKey: "wrong-token", apiSecret: "" }));

      const result = await testShopifyConnectionAction();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).not.toContain("wrong-token");

      const integration = await prisma.integration.findUniqueOrThrow({ where: { provider: "SHOPIFY" } });
      expect(integration.status).toBe("ERREUR");
      expect(integration.lastError).not.toContain("wrong-token");

      // docs/adr/0016-notifications.md — Shopify's connection-error wiring
      // was added this phase, mirroring WooCommerce's pre-existing one.
      const notifications = await prisma.notification.findMany();
      expect(notifications).toHaveLength(1);
      expect(notifications[0].type).toBe("ERREUR_INTEGRATION");
      expect(notifications[0].userId).toBe(teammate.id);
      expect(notifications[0].message).not.toContain("wrong-token");
      expect(notifications.map((n) => n.userId)).not.toContain(actor.id);
    });
  });

  describe("syncShopifyProductsAction", () => {
    beforeEach(() => {
      state.locations = [
        { id: "gid://shopify/Location/10", name: "Entrepôt principal", isActive: true },
        { id: "gid://shopify/Location/11", name: "Ancien entrepôt", isActive: false },
      ];
      state.products = [
        {
          id: "gid://shopify/Product/501",
          title: "Thé vert",
          handle: "the-vert",
          status: "ACTIVE",
          variants: [
            {
              id: "gid://shopify/ProductVariant/601",
              title: "Default Title",
              sku: "THE-VERT",
              price: "50.00",
              inventoryItemId: "gid://shopify/InventoryItem/701",
              tracked: true,
              levels: [{ locationId: "gid://shopify/Location/10", available: 20 }],
            },
          ],
        },
        {
          id: "gid://shopify/Product/502",
          title: "Coffret variable",
          handle: "coffret-variable",
          status: "ACTIVE",
          variants: [
            {
              id: "gid://shopify/ProductVariant/602",
              title: "Rouge",
              sku: "COFFRET-ROUGE",
              price: "80.00",
              inventoryItemId: "gid://shopify/InventoryItem/702",
              tracked: true,
              levels: [{ locationId: "gid://shopify/Location/10", available: 7 }],
            },
            {
              id: "gid://shopify/ProductVariant/603",
              title: "Bleu",
              sku: "",
              price: "85.00",
              inventoryItemId: "gid://shopify/InventoryItem/703",
              tracked: true,
              levels: [{ locationId: "gid://shopify/Location/10", available: 3 }],
            },
          ],
        },
      ];
    });

    it("rejects a caller without integrations.manage permission", async () => {
      await loginAsTestUser({ role: "SALES" });
      await expect(syncShopifyProductsAction()).rejects.toThrow(/non autorisé/i);
    });

    it("imports the active location as a Warehouse, skips the inactive one, and imports products/variants with per-location stock", async () => {
      await loginAsTestUser({ role: "ADMIN" });
      await connectFakeStore();

      const result = await syncShopifyProductsAction();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.summary.imported).toBeGreaterThan(0);

      const warehouses = await prisma.warehouse.findMany({ where: { source: "SHOPIFY" } });
      expect(warehouses).toHaveLength(1);
      expect(warehouses[0].externalId).toBe("gid://shopify/Location/10");

      const simple = await prisma.product.findFirstOrThrow({ where: { source: "SHOPIFY", externalId: "gid://shopify/Product/501" } });
      expect(simple.sku).toBe("THE-VERT");
      expect(Number(simple.price)).toBe(50);

      const stock = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: simple.id } });
      expect(stock.quantityOnHand).toBe(20);
      expect(stock.externalId).toBe("gid://shopify/InventoryItem/701");

      const variable = await prisma.product.findFirstOrThrow({ where: { source: "SHOPIFY", externalId: "gid://shopify/Product/502" } });
      const variations = await prisma.productVariation.findMany({ where: { productId: variable.id } });
      expect(variations).toHaveLength(2);
      const noSku = variations.find((v) => v.sku.startsWith("SHOPIFY-"));
      expect(noSku).toBeTruthy();

      // No InventoryMovement was fabricated merely because this was the first sync.
      expect(await prisma.inventoryMovement.findMany()).toHaveLength(0);

      const locationsRun = await prisma.syncRun.findMany({ where: { resource: "EMPLACEMENTS" } });
      expect(locationsRun).toHaveLength(1);
      expect(locationsRun[0].itemsSkipped).toBe(1); // the inactive location
    });

    it("running the same sync twice is idempotent — no duplicates, second run reports unchanged", async () => {
      await loginAsTestUser({ role: "ADMIN" });
      await connectFakeStore();
      await syncShopifyProductsAction();

      const productsBefore = await prisma.product.count();
      const variationsBefore = await prisma.productVariation.count();
      const result = await syncShopifyProductsAction();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.summary.imported).toBe(0);
      expect(result.data.summary.unchanged).toBeGreaterThan(0);

      expect(await prisma.product.count()).toBe(productsBefore);
      expect(await prisma.productVariation.count()).toBe(variationsBefore);
    });

    it("a changed price is reflected as an update, without touching internal-only fields", async () => {
      await loginAsTestUser({ role: "ADMIN" });
      await connectFakeStore();
      await syncShopifyProductsAction();

      const before = await prisma.product.findFirstOrThrow({ where: { source: "SHOPIFY", externalId: "gid://shopify/Product/501" } });
      await prisma.product.update({ where: { id: before.id }, data: { cost: 15, lowStockThreshold: 4 } });

      state.products[0].variants[0].price = "55.00";
      const result = await syncShopifyProductsAction();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.summary.updated).toBeGreaterThan(0);

      const after = await prisma.product.findFirstOrThrow({ where: { id: before.id } });
      expect(Number(after.price)).toBe(55);
      expect(Number(after.cost)).toBe(15);
      expect(after.lowStockThreshold).toBe(4);
    });
  });

  describe("pushShopifyStockAction", () => {
    it("pushes sellable stock (on-hand minus reserved) per Shopify-linked location, using the InventoryItem's own gid", async () => {
      state.locations = [{ id: "gid://shopify/Location/10", name: "Entrepôt", isActive: true }];
      state.products = [
        {
          id: "gid://shopify/Product/501",
          title: "Thé vert",
          handle: "the-vert",
          status: "ACTIVE",
          variants: [
            {
              id: "gid://shopify/ProductVariant/601",
              title: "Default Title",
              sku: "THE-VERT",
              price: "50.00",
              inventoryItemId: "gid://shopify/InventoryItem/701",
              tracked: true,
              levels: [{ locationId: "gid://shopify/Location/10", available: 20 }],
            },
          ],
        },
      ];

      await loginAsTestUser({ role: "ADMIN" });
      await connectFakeStore();
      await syncShopifyProductsAction();

      const item = await prisma.inventoryItem.findFirstOrThrow({});
      await prisma.inventoryItem.update({ where: { id: item.id }, data: { quantityReserved: 6 } });

      const result = await pushShopifyStockAction();
      expect(result.ok).toBe(true);

      expect(state.stockUpdates).toHaveLength(1);
      expect(state.stockUpdates[0]).toMatchObject({
        inventoryItemId: "gid://shopify/InventoryItem/701",
        locationId: "gid://shopify/Location/10",
        quantity: 14,
      });

      expect(await prisma.inventoryMovement.findMany()).toHaveLength(0);
    });
  });

  describe("syncShopifyOrdersAction", () => {
    async function seedProductWithCost() {
      state.locations = [{ id: "gid://shopify/Location/10", name: "Entrepôt", isActive: true }];
      state.products = [
        {
          id: "gid://shopify/Product/501",
          title: "Thé vert",
          handle: "the-vert",
          status: "ACTIVE",
          variants: [
            {
              id: "gid://shopify/ProductVariant/601",
              title: "Default Title",
              sku: "THE-VERT",
              price: "50.00",
              inventoryItemId: "gid://shopify/InventoryItem/701",
              tracked: true,
              levels: [{ locationId: "gid://shopify/Location/10", available: 20 }],
            },
          ],
        },
      ];

      await loginAsTestUser({ role: "ADMIN" });
      await connectFakeStore();
      await syncShopifyProductsAction();
      const product = await prisma.product.findFirstOrThrow({ where: { source: "SHOPIFY", externalId: "gid://shopify/Product/501" } });
      await prisma.product.update({ where: { id: product.id }, data: { cost: 25 } });
      return product;
    }

    it("imports a registered-customer order with correct totals, line items, and a cost snapshot", async () => {
      const product = await seedProductWithCost();
      const teammate = await createTestUser({ role: "SALES" }); // holds orders.view, distinct from the syncing ADMIN

      state.orders = [
        {
          id: "gid://shopify/Order/9001",
          name: "#9001",
          createdAt: futureIso(),
          displayFinancialStatus: "PAID",
          displayFulfillmentStatus: "UNFULFILLED",
          customer: { id: "gid://shopify/Customer/55", email: "amine@example.com", firstName: "Amine", lastName: "Tazi", phone: "0600000000" },
          shippingAddress: { firstName: "Amine", lastName: "Tazi", address1: "12 Rue Atlas", city: "Casablanca", province: null, country: "MA", phone: "0600000000" },
          paymentGatewayNames: ["cash_on_delivery"],
          total: 95,
          subtotal: 100,
          discounts: 5,
          shipping: 10,
          lineItems: [{ id: "gid://shopify/LineItem/1", title: "Thé vert", sku: "THE-VERT", quantity: 2, productId: "gid://shopify/Product/501", unitPrice: 50, discountedTotal: 90, originalTotal: 100 }],
        },
      ];

      const result = await syncShopifyOrdersAction();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.summary.imported).toBe(1);

      const order = await prisma.order.findFirstOrThrow({ where: { source: "SHOPIFY", externalId: "gid://shopify/Order/9001" }, include: { items: true, customer: true } });
      expect(order.status).toBe("CONFIRMEE");
      expect(order.paymentMethod).toBe("PAIEMENT_LIVRAISON");
      expect(Number(order.total)).toBe(95);
      expect(Number(order.shippingCost)).toBe(10);
      expect(order.items).toHaveLength(1);
      expect(order.items[0].productId).toBe(product.id);
      expect(Number(order.items[0].costSnapshot)).toBe(25);
      expect(order.customer.fullName).toBe("Amine Tazi");
      expect(order.customer.source).toBe("SHOPIFY");

      // docs/adr/0016-notifications.md — new wiring this phase: an imported
      // Shopify order notifies exactly like a manually-created one.
      const notification = await prisma.notification.findFirstOrThrow({ where: { userId: teammate.id } });
      expect(notification.type).toBe("NOUVELLE_COMMANDE");
      expect(notification.message).toContain("Amine Tazi");
      expect(notification.message).toContain("Shopify");
    });

    /**
     * Phase 29 E2E audit — see the matching WooCommerce regression test in
     * tests/actions/woocommerce.test.ts for the full root-cause writeup.
     * Integration.lastSyncAt is shared across every resource; before the
     * fix, an order placed before the preceding products sync (but well
     * within the intended 30-day window) was silently excluded.
     */
    it("imports an order created before the preceding products sync, not just ones dated after it (audit fix)", async () => {
      await seedProductWithCost();
      const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
      state.orders = [
        {
          id: "gid://shopify/Order/9050",
          name: "#9050",
          createdAt: oneHourAgo,
          displayFinancialStatus: "PENDING",
          displayFulfillmentStatus: "UNFULFILLED",
          email: "karim@example.com",
          shippingAddress: { firstName: "Karim", lastName: "Idrissi", address1: "3 Rue Z", city: "Tanger", country: "MA" },
          total: 50,
          subtotal: 50,
          lineItems: [{ id: "gid://shopify/LineItem/6", title: "Thé vert", sku: "THE-VERT", quantity: 1, productId: "gid://shopify/Product/501", unitPrice: 50, discountedTotal: 50, originalTotal: 50 }],
        },
      ];

      const result = await syncShopifyOrdersAction();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.summary.imported).toBe(1);

      const order = await prisma.order.findFirst({ where: { source: "SHOPIFY", externalId: "gid://shopify/Order/9050" } });
      expect(order).not.toBeNull();
    });

    it("deduplicates a guest customer across two orders sharing the same email, without fuzzy name matching", async () => {
      await seedProductWithCost();
      state.orders = [
        {
          id: "gid://shopify/Order/9002",
          name: "#9002",
          createdAt: futureIso(),
          displayFinancialStatus: "PENDING",
          displayFulfillmentStatus: "UNFULFILLED",
          email: "sara@example.com",
          shippingAddress: { firstName: "Sara", lastName: "Amrani", address1: "1 Rue X", city: "Rabat", country: "MA" },
          total: 50,
          subtotal: 50,
          lineItems: [{ id: "gid://shopify/LineItem/2", title: "Thé vert", sku: "THE-VERT", quantity: 1, productId: "gid://shopify/Product/501", unitPrice: 50, discountedTotal: 50, originalTotal: 50 }],
        },
        {
          id: "gid://shopify/Order/9003",
          name: "#9003",
          createdAt: futureIso(),
          displayFinancialStatus: "PENDING",
          displayFulfillmentStatus: "UNFULFILLED",
          email: "sara@example.com",
          shippingAddress: { firstName: "Sara", lastName: "Amrani", address1: "1 Rue X", city: "Rabat", country: "MA" },
          total: 50,
          subtotal: 50,
          lineItems: [{ id: "gid://shopify/LineItem/3", title: "Thé vert", sku: "THE-VERT", quantity: 1, productId: "gid://shopify/Product/501", unitPrice: 50, discountedTotal: 50, originalTotal: 50 }],
        },
      ];

      await syncShopifyOrdersAction();

      const customers = await prisma.customer.findMany({ where: { email: "sara@example.com" } });
      expect(customers).toHaveLength(1);
      const orders = await prisma.order.findMany({ where: { customerId: customers[0].id } });
      expect(orders).toHaveLength(2);
    });

    it("imports a refunded order as a completed Refund and marks paymentStatus REMBOURSE", async () => {
      await seedProductWithCost();
      state.orders = [
        {
          id: "gid://shopify/Order/9004",
          name: "#9004",
          createdAt: futureIso(),
          displayFinancialStatus: "REFUNDED",
          displayFulfillmentStatus: "FULFILLED",
          email: "remb@example.com",
          total: 50,
          subtotal: 50,
          refundedTotal: 50,
          lineItems: [{ id: "gid://shopify/LineItem/4", title: "Thé vert", sku: "THE-VERT", quantity: 1, productId: "gid://shopify/Product/501", unitPrice: 50, discountedTotal: 50, originalTotal: 50 }],
          refunds: [{ id: "gid://shopify/Refund/1", createdAt: futureIso(), total: 50 }],
        },
      ];

      await syncShopifyOrdersAction();

      const order = await prisma.order.findFirstOrThrow({ where: { source: "SHOPIFY", externalId: "gid://shopify/Order/9004" } });
      expect(order.status).toBe("REMBOURSEE");
      expect(order.paymentStatus).toBe("REMBOURSE");

      const refund = await prisma.refund.findFirstOrThrow({ where: { orderId: order.id } });
      expect(refund.status).toBe("COMPLETE");
      expect(refund.source).toBe("SHOPIFY");
      expect(Number(refund.amount)).toBe(50);
    });

    it("skips an order with an unrecognized status combination instead of guessing", async () => {
      await seedProductWithCost();
      state.orders = [
        {
          id: "gid://shopify/Order/9005",
          name: "#9005",
          createdAt: futureIso(),
          displayFinancialStatus: null,
          displayFulfillmentStatus: null,
          email: "unknown@example.com",
          total: 0,
          subtotal: 0,
          lineItems: [],
        },
      ];

      const result = await syncShopifyOrdersAction();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.summary.skipped).toBe(1);
      expect(result.data.summary.imported).toBe(0);

      const order = await prisma.order.findFirst({ where: { source: "SHOPIFY", externalId: "gid://shopify/Order/9005" } });
      expect(order).toBeNull();
    });

    it("re-syncing the same order is idempotent — no duplicates, second run reports unchanged", async () => {
      await seedProductWithCost();
      state.orders = [
        {
          id: "gid://shopify/Order/9006",
          name: "#9006",
          createdAt: futureIso(),
          displayFinancialStatus: "PENDING",
          displayFulfillmentStatus: "UNFULFILLED",
          email: "repeat@example.com",
          total: 50,
          subtotal: 50,
          lineItems: [{ id: "gid://shopify/LineItem/5", title: "Thé vert", sku: "THE-VERT", quantity: 1, productId: "gid://shopify/Product/501", unitPrice: 50, discountedTotal: 50, originalTotal: 50 }],
        },
      ];

      await syncShopifyOrdersAction();
      const countBefore = await prisma.order.count();
      const second = await syncShopifyOrdersAction();
      expect(second.ok).toBe(true);
      if (second.ok) expect(second.data.summary.unchanged).toBe(1);
      expect(await prisma.order.count()).toBe(countBefore);
    });

    it("prevents a duplicate order under a genuine race between two concurrent imports of the same new order", async () => {
      await seedProductWithCost();
      const order = {
        id: "gid://shopify/Order/9100",
        name: "#9100",
        createdAt: futureIso(),
        displayFinancialStatus: "PENDING" as const,
        displayFulfillmentStatus: "UNFULFILLED" as const,
        cancelledAt: null,
        cancelReason: null,
        customer: null,
        email: "race@example.com",
        phone: null,
        shippingAddress: null,
        billingAddress: null,
        paymentGatewayNames: [],
        note: null,
        currentTotalPriceSet: { amount: 50, currency: "MAD" },
        subtotalPriceSet: { amount: 50, currency: "MAD" },
        totalDiscountsSet: { amount: 0, currency: "MAD" },
        totalShippingPriceSet: { amount: 0, currency: "MAD" },
        totalRefundedSet: { amount: 0, currency: "MAD" },
        lineItems: { nodes: [{ id: "gid://shopify/LineItem/6", title: "Thé vert", sku: "THE-VERT", quantity: 1, variant: null, product: { id: "gid://shopify/Product/501" }, originalUnitPriceSet: { amount: 50, currency: "MAD" }, discountedTotalSet: { amount: 50, currency: "MAD" }, originalTotalSet: { amount: 50, currency: "MAD" } }] },
        refunds: [],
      };

      const [a, b] = await Promise.all([importOrder(order, { type: "INTEGRATION" }), importOrder(order, { type: "INTEGRATION" })]);
      expect([a.outcome, b.outcome].filter((o) => o === "imported")).toHaveLength(1);

      const orders = await prisma.order.findMany({ where: { source: "SHOPIFY", externalId: "gid://shopify/Order/9100" } });
      expect(orders).toHaveLength(1);
    });
  });

  describe("disconnectIntegrationAction — Shopify", () => {
    it("clears credentials and resets status", async () => {
      await loginAsTestUser({ role: "ADMIN" });
      await connectFakeStore();

      const result = await disconnectIntegrationAction(formData({ provider: "SHOPIFY" }));
      expect(result.ok).toBe(true);

      const integration = await prisma.integration.findUniqueOrThrow({ where: { provider: "SHOPIFY" } });
      expect(integration.status).toBe("DECONNECTE");
      expect(integration.credentialsEncrypted).toBeNull();
    });
  });
});
