import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";
import {
  connectIntegrationAction,
  disconnectIntegrationAction,
} from "@/actions/integrations";
import {
  testWooCommerceConnectionAction,
  syncWooCommerceProductsAction,
  syncWooCommerceOrdersAction,
  pushWooCommerceStockAction,
  generateWooCommerceWebhookSecretAction,
} from "@/actions/woocommerce";
import { importOrder } from "@/lib/integrations/woocommerce/sync";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import {
  installFakeWooCommerceServer,
  emptyFakeStore,
  FAKE_STORE_URL,
  FAKE_CONSUMER_KEY,
  FAKE_CONSUMER_SECRET,
  type FakeStoreState,
} from "../helpers/fake-woocommerce";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function connectFakeStore() {
  const result = await connectIntegrationAction(
    formData({ provider: "WOOCOMMERCE", siteUrl: FAKE_STORE_URL, apiKey: FAKE_CONSUMER_KEY, apiSecret: FAKE_CONSUMER_SECRET })
  );
  if (!result.ok) throw new Error(`setup failed: ${result.error}`);
  return result.data.id;
}

async function seedDefaultWarehouse() {
  return prisma.warehouse.create({ data: { id: "default-warehouse", name: "Entrepôt principal", isDefault: true } });
}

/**
 * syncWooCommerceOrdersAction bounds its import to orders created after the
 * integration's lastSyncAt (see src/actions/woocommerce.ts) — which the
 * preceding product sync in these tests already advances to "now". Order
 * fixtures must date_created safely after that, not a fixed past date.
 */
function futureIso(minutesFromNow = 5): string {
  return new Date(Date.now() + minutesFromNow * 60_000).toISOString();
}

describe("WooCommerce integration", () => {
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

  describe("connectIntegrationAction — WooCommerce", () => {
    it("rejects a caller without integrations.manage permission", async () => {
      await loginAsTestUser({ role: "SALES" });
      await expect(
        connectIntegrationAction(
          formData({ provider: "WOOCOMMERCE", siteUrl: FAKE_STORE_URL, apiKey: "x", apiSecret: "y" })
        )
      ).rejects.toThrow(/non autorisé/i);
    });

    it("rejects a private/internal store URL (SSRF protection)", async () => {
      await loginAsTestUser({ role: "ADMIN" });
      const result = await connectIntegrationAction(
        formData({ provider: "WOOCOMMERCE", siteUrl: "https://127.0.0.1", apiKey: "x", apiSecret: "y" })
      );
      expect(result.ok).toBe(false);
      const integration = await prisma.integration.findUnique({ where: { provider: "WOOCOMMERCE" } });
      expect(integration).toBeNull();
    });

    it("saves credentials encrypted (never stores or returns plaintext) and lands on CONFIGURE, not CONNECTE", async () => {
      await loginAsTestUser({ role: "ADMIN" });
      const id = await connectFakeStore();

      const integration = await prisma.integration.findUniqueOrThrow({ where: { id } });
      expect(integration.status).toBe("CONFIGURE");
      expect(integration.credentialsEncrypted).not.toBeNull();
      expect(integration.credentialsEncrypted).not.toContain(FAKE_CONSUMER_KEY);
      expect(integration.credentialsEncrypted).not.toContain(FAKE_CONSUMER_SECRET);

      const decrypted = JSON.parse(decryptSecret(integration.credentialsEncrypted!));
      expect(decrypted.apiKey).toBe(FAKE_CONSUMER_KEY);
    });
  });

  describe("testWooCommerceConnectionAction", () => {
    it("rejects a caller without integrations.manage permission", async () => {
      await loginAsTestUser({ role: "WAREHOUSE" });
      await expect(testWooCommerceConnectionAction()).rejects.toThrow(/non autorisé/i);
    });

    it("returns an error when nothing is configured yet", async () => {
      await loginAsTestUser({ role: "ADMIN" });
      const result = await testWooCommerceConnectionAction();
      expect(result.ok).toBe(false);
    });

    it("advances status to CONNECTE on a real successful authenticated request", async () => {
      await loginAsTestUser({ role: "ADMIN" });
      await connectFakeStore();

      const result = await testWooCommerceConnectionAction();
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.status).toBe("CONNECTE");

      const integration = await prisma.integration.findUniqueOrThrow({ where: { provider: "WOOCOMMERCE" } });
      expect(integration.status).toBe("CONNECTE");
      expect(integration.lastConnectionCheckAt).not.toBeNull();

      const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "integration.connection_test_succeeded" } });
      expect(audit).toBeTruthy();
    });

    it("sets status to ERREUR with a safe message on invalid credentials, never leaking the secret", async () => {
      await loginAsTestUser({ role: "ADMIN" });
      const connectResult = await connectIntegrationAction(
        formData({ provider: "WOOCOMMERCE", siteUrl: FAKE_STORE_URL, apiKey: "wrong-key", apiSecret: "wrong-secret" })
      );
      expect(connectResult.ok).toBe(true);

      const result = await testWooCommerceConnectionAction();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).not.toContain("wrong-key");
        expect(result.error).not.toContain("wrong-secret");
      }

      const integration = await prisma.integration.findUniqueOrThrow({ where: { provider: "WOOCOMMERCE" } });
      expect(integration.status).toBe("ERREUR");
      expect(integration.lastError).not.toContain("wrong-key");
    });
  });

  describe("syncWooCommerceProductsAction", () => {
    beforeEach(async () => {
      await seedDefaultWarehouse();
      state.categories = [
        { id: 301, name: "Boissons", slug: "boissons" },
        { id: 302, name: "Thé", slug: "the", parent: 301 },
      ];
      state.products = [
        {
          id: 501,
          name: "Thé vert",
          slug: "the-vert",
          sku: "THE-VERT",
          status: "publish",
          type: "simple",
          regular_price: "50.00",
          manage_stock: true,
          stock_quantity: 20,
          categories: [{ id: 302, name: "Thé", slug: "the" }],
        },
        {
          id: 502,
          name: "Sans SKU",
          slug: "sans-sku",
          sku: "",
          status: "draft",
          type: "simple",
          regular_price: "10.00",
          manage_stock: false,
          stock_quantity: null,
          categories: [],
        },
        {
          id: 503,
          name: "Coffret variable",
          slug: "coffret-variable",
          sku: "COFFRET",
          status: "publish",
          type: "variable",
          regular_price: "0.00",
          manage_stock: false,
          stock_quantity: null,
          categories: [],
          variations: [601],
          variationList: [
            {
              id: 601,
              sku: "COFFRET-ROUGE",
              regular_price: "80.00",
              manage_stock: true,
              stock_quantity: 7,
              attributes: [{ name: "Couleur", option: "Rouge" }],
            },
          ],
        },
      ];
    });

    it("rejects a caller without integrations.manage permission", async () => {
      await loginAsTestUser({ role: "SALES" });
      await expect(syncWooCommerceProductsAction()).rejects.toThrow(/non autorisé/i);
    });

    it("imports categories (with parent linking), products, a variation, and initializes stock — with an honest per-resource summary", async () => {
      await loginAsTestUser({ role: "ADMIN" });
      await connectFakeStore();

      const result = await syncWooCommerceProductsAction();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.summary.imported).toBe(4); // 3 top-level products + 1 variation
      expect(result.data.summary.failed).toBe(0);

      const parent = await prisma.category.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "301" } });
      const child = await prisma.category.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "302" } });
      expect(child.parentId).toBe(parent.id);

      const teVert = await prisma.product.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "501" } });
      expect(teVert.sku).toBe("THE-VERT");
      expect(teVert.status).toBe("ACTIF");
      expect(teVert.categoryId).toBe(child.id);
      expect(Number(teVert.price)).toBe(50);

      const noSku = await prisma.product.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "502" } });
      expect(noSku.sku).toBe("WC-502"); // deterministic fallback, never an empty string
      expect(noSku.status).toBe("BROUILLON");

      const coffret = await prisma.product.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "503" } });
      const variation = await prisma.productVariation.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "601" } });
      expect(variation.productId).toBe(coffret.id);
      expect(variation.attributes).toEqual({ Couleur: "Rouge" });

      const teVertStock = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: teVert.id } });
      expect(teVertStock.quantityOnHand).toBe(20);
      const variationStock = await prisma.inventoryItem.findFirstOrThrow({ where: { variationId: variation.id } });
      expect(variationStock.quantityOnHand).toBe(7);

      // No InventoryMovement was fabricated merely because this was the
      // first sync — initialization is not a business event.
      const movements = await prisma.inventoryMovement.findMany();
      expect(movements).toHaveLength(0);

      const syncRuns = await prisma.syncRun.findMany({ where: { resource: "PRODUITS" } });
      expect(syncRuns).toHaveLength(1);
      expect(syncRuns[0].status).toBe("SUCCES");
    });

    it("running the same sync twice is idempotent — no duplicates, second run reports unchanged", async () => {
      await loginAsTestUser({ role: "ADMIN" });
      await connectFakeStore();
      await syncWooCommerceProductsAction();

      const countBefore = await prisma.product.count();
      const result = await syncWooCommerceProductsAction();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.summary.imported).toBe(0);
      expect(result.data.summary.unchanged).toBeGreaterThan(0);

      const countAfter = await prisma.product.count();
      expect(countAfter).toBe(countBefore);
    });

    it("a changed price on the store is reflected as an update on the next sync, without touching internal-only fields", async () => {
      await loginAsTestUser({ role: "ADMIN" });
      await connectFakeStore();
      await syncWooCommerceProductsAction();

      const before = await prisma.product.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "501" } });
      await prisma.product.update({ where: { id: before.id }, data: { cost: 20, lowStockThreshold: 3 } });

      state.products[0].regular_price = "55.00";
      const result = await syncWooCommerceProductsAction();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.summary.updated).toBeGreaterThan(0);

      const after = await prisma.product.findFirstOrThrow({ where: { id: before.id } });
      expect(Number(after.price)).toBe(55);
      // cost and lowStockThreshold are internal-only — never touched by sync.
      expect(Number(after.cost)).toBe(20);
      expect(after.lowStockThreshold).toBe(3);
    });
  });

  describe("pushWooCommerceStockAction", () => {
    it("pushes sellable stock (on-hand minus reserved), not raw on-hand", async () => {
      await seedDefaultWarehouse();
      state.products = [
        {
          id: 501,
          name: "Thé vert",
          slug: "the-vert",
          sku: "THE-VERT",
          status: "publish",
          type: "simple",
          regular_price: "50.00",
          manage_stock: true,
          stock_quantity: 20,
          categories: [],
        },
      ];

      await loginAsTestUser({ role: "ADMIN" });
      await connectFakeStore();
      await syncWooCommerceProductsAction();

      const item = await prisma.inventoryItem.findFirstOrThrow({});
      await prisma.inventoryItem.update({ where: { id: item.id }, data: { quantityReserved: 5 } });

      const result = await pushWooCommerceStockAction();
      expect(result.ok).toBe(true);

      expect(state.stockUpdates).toHaveLength(1);
      expect(state.stockUpdates[0].body).toMatchObject({ stock_quantity: 15 });

      // Nothing internal changed — a push never fabricates a movement.
      const movements = await prisma.inventoryMovement.findMany();
      expect(movements).toHaveLength(0);
    });
  });

  describe("syncWooCommerceOrdersAction", () => {
    beforeEach(async () => {
      await seedDefaultWarehouse();
      state.products = [
        {
          id: 501,
          name: "Thé vert",
          slug: "the-vert",
          sku: "THE-VERT",
          status: "publish",
          type: "simple",
          regular_price: "50.00",
          manage_stock: true,
          stock_quantity: 20,
          categories: [],
        },
      ];
    });

    async function seedProductWithCost() {
      await loginAsTestUser({ role: "ADMIN" });
      await connectFakeStore();
      await syncWooCommerceProductsAction();
      const product = await prisma.product.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "501" } });
      await prisma.product.update({ where: { id: product.id }, data: { cost: 30 } });
      return product;
    }

    it("imports a registered-customer order with correct totals, line items, and a cost snapshot from the internal product", async () => {
      const product = await seedProductWithCost();

      state.orders = [
        {
          id: 9001,
          number: "9001",
          status: "processing",
          date_created: futureIso(),
          date_paid: "2026-01-10T10:05:00",
          customer_id: 55,
          total: "95.00",
          shipping_total: "10.00",
          discount_total: "5.00",
          payment_method: "cod",
          billing: { first_name: "Amine", last_name: "Tazi", email: "amine@example.com", phone: "0600000000", city: "Casablanca", country: "MA", address_1: "12 Rue Atlas" },
          shipping: {},
          line_items: [
            { id: 1, name: "Thé vert", product_id: 501, sku: "THE-VERT", quantity: 2, price: "50.00", subtotal: "100.00", total: "90.00" },
          ],
        },
      ];

      const result = await syncWooCommerceOrdersAction();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.summary.imported).toBe(1);

      const order = await prisma.order.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "9001" }, include: { items: true, customer: true } });
      expect(order.status).toBe("CONFIRMEE");
      expect(order.paymentMethod).toBe("PAIEMENT_LIVRAISON");
      expect(Number(order.total)).toBe(95);
      expect(Number(order.shippingCost)).toBe(10);
      expect(order.items).toHaveLength(1);
      expect(order.items[0].productId).toBe(product.id);
      expect(Number(order.items[0].costSnapshot)).toBe(30);
      expect(order.items[0].discount.toString()).not.toBeNull();
      expect(order.customer.fullName).toBe("Amine Tazi");
      expect(order.customer.source).toBe("WOOCOMMERCE");
    });

    it("deduplicates a guest customer across two orders sharing the same billing e-mail, without fuzzy name matching", async () => {
      await seedProductWithCost();
      state.orders = [
        {
          id: 9002,
          number: "9002",
          status: "pending",
          date_created: futureIso(),
          customer_id: 0,
          total: "50.00",
          billing: { first_name: "Sara", last_name: "Amrani", email: "sara@example.com", city: "Rabat", country: "MA", address_1: "1 Rue X" },
          shipping: {},
          line_items: [{ id: 2, name: "Thé vert", product_id: 501, sku: "THE-VERT", quantity: 1, price: "50.00", subtotal: "50.00", total: "50.00" }],
        },
        {
          id: 9003,
          number: "9003",
          status: "pending",
          date_created: futureIso(),
          customer_id: 0,
          total: "50.00",
          billing: { first_name: "Sara", last_name: "Amrani", email: "sara@example.com", city: "Rabat", country: "MA", address_1: "1 Rue X" },
          shipping: {},
          line_items: [{ id: 3, name: "Thé vert", product_id: 501, sku: "THE-VERT", quantity: 1, price: "50.00", subtotal: "50.00", total: "50.00" }],
        },
      ];

      await syncWooCommerceOrdersAction();

      const customers = await prisma.customer.findMany({ where: { email: "sara@example.com" } });
      expect(customers).toHaveLength(1);
      const orders = await prisma.order.findMany({ where: { customerId: customers[0].id } });
      expect(orders).toHaveLength(2);
    });

    it("imports a refunded order as a completed Refund and marks paymentStatus REMBOURSE", async () => {
      await seedProductWithCost();
      state.orders = [
        {
          id: 9004,
          number: "9004",
          status: "refunded",
          date_created: futureIso(),
          customer_id: 0,
          total: "50.00",
          billing: { first_name: "Client", last_name: "Remboursé", email: "remb@example.com", city: "Fès", country: "MA", address_1: "2 Rue Y" },
          shipping: {},
          line_items: [{ id: 4, name: "Thé vert", product_id: 501, sku: "THE-VERT", quantity: 1, price: "50.00", subtotal: "50.00", total: "50.00" }],
          refunds: [{ id: 1, total: "-50.00" }],
        },
      ];

      await syncWooCommerceOrdersAction();

      const order = await prisma.order.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "9004" } });
      expect(order.status).toBe("REMBOURSEE");
      expect(order.paymentStatus).toBe("REMBOURSE");

      const refund = await prisma.refund.findFirstOrThrow({ where: { orderId: order.id } });
      expect(refund.status).toBe("COMPLETE");
      expect(refund.source).toBe("WOOCOMMERCE");
      expect(Number(refund.amount)).toBe(50);
    });

    it("skips an order in a checkout-draft state instead of importing it or guessing a mapping", async () => {
      await seedProductWithCost();
      state.orders = [
        {
          id: 9005,
          number: "9005",
          status: "checkout-draft",
          date_created: futureIso(),
          customer_id: 0,
          total: "0.00",
          billing: { email: null },
          shipping: {},
          line_items: [],
        },
      ];

      const result = await syncWooCommerceOrdersAction();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.summary.skipped).toBe(1);
      expect(result.data.summary.imported).toBe(0);

      const order = await prisma.order.findFirst({ where: { source: "WOOCOMMERCE", externalId: "9005" } });
      expect(order).toBeNull();
    });

    it("re-syncing the same order is idempotent — no duplicate order rows, second run reports unchanged", async () => {
      await seedProductWithCost();
      state.orders = [
        {
          id: 9006,
          number: "9006",
          status: "processing",
          date_created: futureIso(),
          customer_id: 0,
          total: "50.00",
          billing: { first_name: "R", last_name: "S", email: "repeat@example.com", city: "Rabat", country: "MA", address_1: "x" },
          shipping: {},
          line_items: [{ id: 5, name: "Thé vert", product_id: 501, sku: "THE-VERT", quantity: 1, price: "50.00", subtotal: "50.00", total: "50.00" }],
        },
      ];

      await syncWooCommerceOrdersAction();
      const countBefore = await prisma.order.count();
      const second = await syncWooCommerceOrdersAction();
      expect(second.ok).toBe(true);
      if (second.ok) expect(second.data.summary.unchanged).toBe(1);
      expect(await prisma.order.count()).toBe(countBefore);
    });

    it("prevents a duplicate order under a genuine race between two concurrent imports of the same new order", async () => {
      await seedProductWithCost();
      const wcOrder = {
        id: 9100,
        number: "9100",
        status: "processing" as const,
        currency: "MAD",
        date_created: "2026-01-16T10:00:00",
        date_paid: null,
        customer_id: 0,
        total: 50,
        total_tax: 0,
        shipping_total: 0,
        discount_total: 0,
        payment_method: "cod",
        payment_method_title: null,
        customer_note: null,
        billing: {
          first_name: "Race",
          last_name: "Condition",
          company: null,
          address_1: "x",
          address_2: null,
          city: "Rabat",
          state: null,
          postcode: null,
          country: "MA",
          email: "race@example.com",
          phone: null,
        },
        shipping: {
          first_name: "",
          last_name: "",
          company: null,
          address_1: "",
          address_2: null,
          city: "",
          state: null,
          postcode: null,
          country: "",
          email: null,
          phone: null,
        },
        line_items: [
          { id: 6, name: "Thé vert", product_id: 501, variation_id: null, sku: "THE-VERT", quantity: 1, price: 50, subtotal: 50, total: 50, total_tax: 0 },
        ],
        refunds: [],
      };

      const [a, b] = await Promise.all([
        importOrder(wcOrder, { type: "INTEGRATION" }),
        importOrder(wcOrder, { type: "INTEGRATION" }),
      ]);
      expect([a.outcome, b.outcome].filter((o) => o === "imported")).toHaveLength(1);

      const orders = await prisma.order.findMany({ where: { source: "WOOCOMMERCE", externalId: "9100" } });
      expect(orders).toHaveLength(1);
    });
  });

  describe("generateWooCommerceWebhookSecretAction", () => {
    it("returns the secret exactly once and stores only its encrypted form", async () => {
      await loginAsTestUser({ role: "ADMIN" });
      await connectFakeStore();

      const result = await generateWooCommerceWebhookSecretAction();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.secret.length).toBeGreaterThanOrEqual(32);

      const integration = await prisma.integration.findUniqueOrThrow({ where: { provider: "WOOCOMMERCE" } });
      expect(integration.credentialsEncrypted).not.toContain(result.data.secret);
      const decrypted = JSON.parse(decryptSecret(integration.credentialsEncrypted!));
      expect(decrypted.webhookSecret).toBe(result.data.secret);
    });
  });

  describe("disconnectIntegrationAction — WooCommerce", () => {
    it("clears credentials and resets status", async () => {
      await loginAsTestUser({ role: "ADMIN" });
      await connectFakeStore();

      const result = await disconnectIntegrationAction(formData({ provider: "WOOCOMMERCE" }));
      expect(result.ok).toBe(true);

      const integration = await prisma.integration.findUniqueOrThrow({ where: { provider: "WOOCOMMERCE" } });
      expect(integration.status).toBe("DECONNECTE");
      expect(integration.credentialsEncrypted).toBeNull();
    });
  });
});
