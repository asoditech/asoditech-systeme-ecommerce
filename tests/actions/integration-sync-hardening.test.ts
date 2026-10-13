import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import {
  setWooCommerceImportHistoricalOrdersAction,
  syncWooCommerceOrdersAction,
  syncWooCommerceProductsAction,
} from "@/actions/woocommerce";
import { POST as wooWebhook } from "@/app/api/webhooks/woocommerce/route";
import { claimSyncLease, releaseSyncLease, SYNC_ALREADY_RUNNING_MESSAGE } from "@/lib/integrations/shared/integration-config";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import {
  FAKE_CONSUMER_KEY,
  FAKE_CONSUMER_SECRET,
  FAKE_STORE_URL,
  emptyFakeStore,
  installFakeWooCommerceServer,
  type FakeOrder,
  type FakeStoreState,
} from "../helpers/fake-woocommerce";

/**
 * 2026-10-12 hardening of the store sync (DB-backed, fake WooCommerce API):
 * per-page resume cursor, no duplicates on repeated / concurrent syncs,
 * optional historical backfill, unsupported statuses reported, and the
 * remote product deletion rules (sticky archive, product.restored, removed
 * variations deactivated — never deleted).
 */

const WEBHOOK_SECRET = "sync-hardening-secret";
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

async function connectedStore(config: Record<string, unknown> = {}) {
  await prisma.warehouse.create({ data: { id: "default-warehouse", name: "Entrepôt principal", isDefault: true } });
  return prisma.integration.create({
    data: {
      provider: "WOOCOMMERCE",
      status: "CONNECTE",
      config: { siteUrl: FAKE_STORE_URL, ...config },
      credentialsEncrypted: encryptSecret(
        JSON.stringify({ apiKey: FAKE_CONSUMER_KEY, apiSecret: FAKE_CONSUMER_SECRET, webhookSecret: WEBHOOK_SECRET })
      ),
    },
  });
}

/** Newest first, like WooCommerce's REST default: index 0 = most recent. */
function order(id: number, opts: { status?: string; date?: string } = {}): FakeOrder {
  return {
    id,
    number: String(id),
    status: opts.status ?? "processing",
    date_created: opts.date ?? new Date(Date.now() - id * 1000).toISOString(),
    date_paid: null,
    customer_id: 0,
    total: "50.00",
    shipping_total: "0.00",
    discount_total: "0.00",
    payment_method: "cod",
    billing: { first_name: "Client", last_name: String(id), email: null, phone: `06${String(10_000_000 + id).slice(-8)}`, city: "Casablanca", country: "MA", address_1: "Rue 1" },
    shipping: {},
    line_items: [{ id: 1, name: "Article", product_id: null, sku: null, quantity: 1, price: "50.00", subtotal: "50.00", total: "50.00" }],
  };
}

async function config(): Promise<Record<string, unknown>> {
  const row = await prisma.integration.findFirstOrThrow({ where: { provider: "WOOCOMMERCE" } });
  return (row.config as Record<string, unknown>) ?? {};
}

/** Clicks « Synchroniser » until the backlog is done, like runSyncLoop. */
async function syncAll(max = 20) {
  const totals = { imported: 0, runs: 0, notes: [] as string[] };
  for (let i = 0; i < max; i++) {
    const res = await syncWooCommerceOrdersAction();
    if (!res.ok) throw new Error(res.error);
    totals.imported += res.data.summary.imported;
    totals.notes.push(...res.data.summary.notes);
    totals.runs++;
    if (!res.data.summary.hasMore) break;
  }
  return totals;
}

describe("orders sync — pagination, idempotency, concurrency", () => {
  it("imports a two-page backlog over several capped runs, then a repeated sync imports nothing (no duplicate)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await connectedStore();
    state.orders = Array.from({ length: 52 }, (_, i) => order(1000 + i));

    const first = await syncAll();
    expect(first.imported).toBe(52);
    expect(first.runs).toBeGreaterThan(1); // 15 new orders per run at most
    expect(await prisma.order.count({ where: { source: "WOOCOMMERCE" } })).toBe(52);

    const again = await syncWooCommerceOrdersAction();
    expect(again.ok && again.data.summary.imported).toBe(0);
    expect(await prisma.order.count({ where: { source: "WOOCOMMERCE" } })).toBe(52);
    expect((await config()).ordersResumePage).toBe(1);
  });

  it("the resume page is saved after EVERY page: a run that dies on page 2 still resumes at page 2", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await connectedStore();
    // Page 1: 50 orders with a plugin status (skipped, no import cap hit); page 2 fails.
    state.orders = [...Array.from({ length: 50 }, (_, i) => order(2000 + i, { status: "shipped" })), order(3000)];
    const fakeStore = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(input.toString());
        if (url.pathname.endsWith("/orders") && url.searchParams.get("page") === "2") {
          return new Response(JSON.stringify({ code: "rest_forbidden", message: "refusé" }), { status: 403, headers: { "content-type": "application/json" } });
        }
        return fakeStore(input, init);
      })
    );

    const run = await syncWooCommerceOrdersAction();
    expect(run.ok).toBe(false);
    expect((await config()).ordersResumePage).toBe(2);
  });

  it("a second sync while one is running is refused, never run twice; the lease is released after a run", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const integration = await connectedStore();
    state.orders = [order(4001)];

    expect(await claimSyncLease(integration.id, "orders")).toBe(true);
    const refused = await syncWooCommerceOrdersAction();
    expect(refused).toEqual({ ok: false, error: SYNC_ALREADY_RUNNING_MESSAGE });
    expect(await prisma.order.count()).toBe(0);
    await releaseSyncLease(integration.id, "orders");

    const ok = await syncWooCommerceOrdersAction();
    expect(ok.ok && ok.data.summary.imported).toBe(1);
    // Released again: the next click is accepted.
    expect(await claimSyncLease(integration.id, "orders")).toBe(true);
  });

  it("two claims racing: exactly one wins; an expired lease (crashed run) can be taken over", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const integration = await connectedStore();
    const results = await Promise.all([claimSyncLease(integration.id, "orders"), claimSyncLease(integration.id, "orders")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await claimSyncLease(integration.id, "orders", new Date(Date.now() + 3 * 60_000))).toBe(true);
  });

  it("other config keys survive a sync (no lost update of the whole JSON)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await connectedStore({ forceNouvelleOnImport: false, productsResumePage: 7 });
    state.orders = [order(5001)];
    await syncWooCommerceOrdersAction();
    expect(await config()).toMatchObject({ siteUrl: FAKE_STORE_URL, forceNouvelleOnImport: false, productsResumePage: 7, ordersResumePage: 1 });
  });
});

describe("orders sync — optional historical backfill", () => {
  it("history OFF: only orders placed after the switch are imported; ON again: the history follows", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await connectedStore();
    const off = await setWooCommerceImportHistoricalOrdersAction(false);
    expect(off.ok).toBe(true);
    const future = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
    state.orders = [order(6003, { date: future(2) }), order(6002, { date: future(1) }), order(6001, { date: "2025-01-01T10:00:00" })];

    const run = await syncAll();
    expect(run.imported).toBe(2);
    expect(run.notes.join(" ")).toMatch(/Historique non importé/);
    expect(await prisma.order.findFirst({ where: { externalId: "6001" } })).toBeNull();
    expect(await config()).toMatchObject({ importHistoricalOrders: false, ordersResumePage: 1 });

    await setWooCommerceImportHistoricalOrdersAction(true);
    const back = await syncAll();
    expect(back.imported).toBe(1);
    expect(await prisma.order.count({ where: { source: "WOOCOMMERCE" } })).toBe(3);
    const audit = await prisma.auditEvent.findMany({ where: { action: "integration.updated" } });
    expect(audit.map((a) => (a.metadata as { change?: string }).change)).toContain("import_historical_orders");
  });
});

describe("orders sync — unsupported store statuses are reported, not silently skipped", () => {
  it("counts them per status in one note; supported orders still import", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await connectedStore();
    state.orders = [order(7003, { status: "shipped" }), order(7002, { status: "shipped" }), order(7001)];
    const res = await syncWooCommerceOrdersAction();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.summary.imported).toBe(1);
    expect(res.data.summary.skipped).toBe(2);
    expect(res.data.summary.notes).toContain("2 commande(s) ignorée(s) : statut WooCommerce non pris en charge (shipped ×2).");
  });
});

// ---------------------------------------------------------------------------
// Remote product deletion / deactivation
// ---------------------------------------------------------------------------

const sign = (body: string) => createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("base64");
const hook = (topic: string, deliveryId: string, payload: object) => {
  const body = JSON.stringify(payload);
  return wooWebhook(
    new Request("https://app.example/api/webhooks/woocommerce", {
      method: "POST",
      headers: { "content-type": "application/json", "x-wc-webhook-signature": sign(body), "x-wc-webhook-topic": topic, "x-wc-webhook-delivery-id": deliveryId },
      body,
    })
  );
};

const simple = (id: number, sku: string) => ({
  id,
  name: `Produit ${sku}`,
  slug: `p-${id}`,
  sku,
  status: "publish",
  type: "simple",
  regular_price: "100.00",
  manage_stock: false,
  stock_quantity: null,
  categories: [],
});

describe("remote product deletion", () => {
  it("deleted in the store → ARCHIVE with its history; a later sync keeps it archived and never duplicates it", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await connectedStore();
    state.products = [simple(8001, "DEL-1")];
    await syncWooCommerceProductsAction();
    const product = await prisma.product.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "8001" } });
    const customer = await prisma.customer.create({ data: { fullName: "Client Historique" } });
    await prisma.order.create({
      data: {
        customerId: customer.id,
        status: "LIVREE",
        subtotal: 100,
        total: 100,
        currency: "MAD",
        items: { create: [{ productId: product.id, nameSnapshot: product.name, skuSnapshot: product.sku, quantity: 1, unitPrice: 100, total: 100 }] },
      },
    });

    expect((await hook("product.deleted", "d-del-1", { id: 8001 })).status).toBe(200);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).status).toBe("ARCHIVE");

    // The store still serves it (e.g. a cached listing / later restore not yet signalled): stays archived.
    await syncWooCommerceProductsAction();
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).status).toBe("ARCHIVE");
    expect(await prisma.product.count({ where: { name: "Produit DEL-1" } })).toBe(1);
    expect(await prisma.orderItem.count({ where: { productId: product.id } })).toBe(1);
  });

  it("an ASODITECH manual archive is not undone by the next sync or product.updated webhook", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await connectedStore();
    state.products = [simple(8101, "MAN-1")];
    await syncWooCommerceProductsAction();
    const product = await prisma.product.findFirstOrThrow({ where: { externalId: "8101" } });
    await prisma.product.update({ where: { id: product.id }, data: { status: "ARCHIVE" } });

    state.products[0] = { ...simple(8101, "MAN-1"), regular_price: "120.00" };
    await syncWooCommerceProductsAction();
    expect(await hook("product.updated", "d-upd-1", state.products[0])).toHaveProperty("status", 200);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.status).toBe("ARCHIVE");
    expect(Number(after.price)).toBe(120); // other fields keep syncing
  });

  it("product.restored → back to the store's real status, audited", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await connectedStore();
    state.products = [simple(8201, "RES-1")];
    await syncWooCommerceProductsAction();
    await hook("product.deleted", "d-del-2", { id: 8201 });
    const product = await prisma.product.findFirstOrThrow({ where: { externalId: "8201" } });
    expect(product.status).toBe("ARCHIVE");

    expect((await hook("product.restored", "d-res-1", { id: 8201 })).status).toBe(200);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).status).toBe("ACTIF");
    expect(await prisma.auditEvent.findFirst({ where: { entityId: product.id, action: "product.restored" } })).not.toBeNull();
    expect(await prisma.product.count({ where: { externalId: "8201" } })).toBe(1);
  });

  it("a temporary store API failure during product.restored changes nothing and is retried (500)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await connectedStore();
    state.products = [simple(8301, "TMP-1")];
    await syncWooCommerceProductsAction();
    await hook("product.deleted", "d-del-3", { id: 8301 });
    state.products = []; // the store can't serve it right now → 404
    expect((await hook("product.restored", "d-res-2", { id: 8301 })).status).toBe(500);
    expect((await prisma.product.findFirstOrThrow({ where: { externalId: "8301" } })).status).toBe("ARCHIVE");
    expect((await prisma.webhookEvent.findFirstOrThrow({ where: { deliveryId: "d-res-2" } })).status).toBe("ECHEC");
  });
});

describe("variations removed in the store", () => {
  const variable = (variations: { id: number; sku: string; color: string }[]) => ({
    ...simple(8401, "VAR-PARENT"),
    type: "variable",
    variations: variations.map((v) => v.id),
    variationList: variations.map((v) => ({
      id: v.id,
      sku: v.sku,
      regular_price: "90.00",
      manage_stock: false,
      stock_quantity: null,
      attributes: [{ name: "Couleur", option: v.color }],
    })),
  });

  it("a variation gone from a full fetch is deactivated (kept, never deleted); the others stay active", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await connectedStore();
    state.products = [variable([{ id: 8411, sku: "VAR-R", color: "Rouge" }, { id: 8412, sku: "VAR-B", color: "Bleu" }])];
    await syncWooCommerceProductsAction();
    expect(await prisma.productVariation.count({ where: { isActive: true, source: "WOOCOMMERCE" } })).toBe(2);

    state.products = [variable([{ id: 8411, sku: "VAR-R", color: "Rouge" }])];
    await syncWooCommerceProductsAction();
    const rows = await prisma.productVariation.findMany({ where: { source: "WOOCOMMERCE" }, orderBy: { externalId: "asc" } });
    expect(rows.map((r) => [r.externalId, r.isActive])).toEqual([
      ["8411", true],
      ["8412", false],
    ]);
  });

  it("a failed variation fetch deactivates nothing", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await connectedStore();
    state.products = [variable([{ id: 8421, sku: "VAR-G", color: "Vert" }])];
    await syncWooCommerceProductsAction();
    const fakeStore = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) =>
        /\/products\/\d+\/variations/.test(new URL(input.toString()).pathname)
          ? new Response(JSON.stringify({ code: "rest_forbidden" }), { status: 403, headers: { "content-type": "application/json" } })
          : fakeStore(input, init)
      )
    );
    await syncWooCommerceProductsAction();
    expect(await prisma.productVariation.count({ where: { isActive: true, source: "WOOCOMMERCE" } })).toBe(1);
  });
});
