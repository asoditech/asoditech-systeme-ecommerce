import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { importOrder as importWooOrder } from "@/lib/integrations/woocommerce/sync";
import { importOrder as importShopifyOrder } from "@/lib/integrations/shopify/sync";
import { wcOrderSchema } from "@/lib/integrations/woocommerce/types";
import { shopifyOrderSchema } from "@/lib/integrations/shopify/types";
import { resetDb } from "../helpers/db";
import { createTestUser, loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { serializeOrder, type FakeOrder } from "../helpers/fake-shopify";

/**
 * Order sync consistency (WooCommerce + Shopify, shared/order-sync-rules.ts):
 * stock ledger ⟺ status (ADR 0030/0036) whatever side moves the order, no
 * duplicate order / movement / refund on replay, partial refunds kept, store
 * dates recorded, stale snapshots never undo newer local decisions. Each test
 * asserts the ledger (movements, reserved units), refunds, dates and status.
 */

const actor = { type: "INTEGRATION" } as const;
const ON = { forceNouvelleOnFirstImport: true };
const OFF = { forceNouvelleOnFirstImport: false };
const gmt = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString().slice(0, 19); // Woo *_gmt
const iso = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  await loginAsTestUser({ role: "ADMIN" });
  const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt principal", isDefault: true } });
  const woo = await prisma.product.create({ data: { name: "Thé", sku: "THE-WC", price: 50, status: "ACTIF", source: "WOOCOMMERCE", externalId: "501", trackInventory: true } });
  const shop = await prisma.product.create({
    data: { name: "Thé S", sku: "THE-SH", price: 50, status: "ACTIF", source: "SHOPIFY", externalId: "gid://shopify/Product/501", trackInventory: true },
  });
  await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: woo.id, quantityOnHand: 15 } });
  await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: shop.id, quantityOnHand: 15 } });
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  vi.restoreAllMocks();
});

function woo(overrides: Record<string, unknown> = {}) {
  return wcOrderSchema.parse({
    id: 7001,
    number: "7001",
    status: "processing",
    date_created: "2026-01-20T10:00:00",
    total: "100.00",
    billing: { first_name: "Sara", last_name: "Amrani", phone: "0611223344" },
    shipping: {},
    line_items: [{ id: 1, name: "Thé", product_id: 501, sku: "THE-WC", quantity: 2, price: "50.00", subtotal: "100.00", total: "100.00" }],
    ...overrides,
  });
}

function shop(overrides: Partial<FakeOrder> = {}) {
  const fake: FakeOrder = {
    id: "gid://shopify/Order/7001",
    name: "#7001",
    createdAt: "2026-01-20T10:00:00Z",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    phone: "0611223344",
    customer: { id: "gid://shopify/Customer/1", firstName: "Sara", lastName: "Amrani", phone: "0611223344" },
    total: 100,
    subtotal: 100,
    lineItems: [{ id: "gid://shopify/LineItem/1", title: "Thé S", sku: "THE-SH", quantity: 2, productId: "gid://shopify/Product/501", unitPrice: 50, discountedTotal: 100, originalTotal: 100 }],
    ...overrides,
  };
  return shopifyOrderSchema.parse(serializeOrder(fake));
}

const PROVIDERS = [
  {
    name: "WooCommerce",
    source: "WOOCOMMERCE" as const,
    sku: "THE-WC",
    importOrder: (o: unknown, opts = ON) => importWooOrder(o as ReturnType<typeof woo>, actor, opts),
    confirmed: () => woo({ status: "processing" }),
    failed: () => woo({ status: "failed" }),
    cancelled: (modifiedSec: number | null) => woo({ status: "cancelled", date_modified_gmt: modifiedSec === null ? undefined : gmt(modifiedSec) }),
    /** Cancellation whose store modification time is `at` (null = absent, "invalid" = unparseable). */
    cancelledAt: (at: Date | null | "invalid") => woo({ status: "cancelled", date_modified_gmt: at === null ? undefined : at === "invalid" ? "pas-une-date" : at.toISOString().slice(0, 19) }),
    /** Store reopen (pending) modified at `at`. */
    reopenedAt: (at: Date) => woo({ status: "pending", date_modified_gmt: at.toISOString().slice(0, 19) }),
    /** Cancelled on the store with `refunded` (0 = none) refunded there. */
    cancelledRefunded: (refunded: number) => woo({ status: "cancelled", date_modified_gmt: gmt(+600), refunds: refunded > 0 ? [{ id: 9, total: `-${refunded.toFixed(2)}` }] : [] }),
  },
  {
    name: "Shopify",
    source: "SHOPIFY" as const,
    sku: "THE-SH",
    importOrder: (o: unknown, opts = ON) => importShopifyOrder(o as ReturnType<typeof shop>, actor, opts),
    confirmed: () => shop(),
    failed: () => shop({ displayFinancialStatus: "EXPIRED" }),
    cancelled: (modifiedSec: number | null) => shop({ cancelledAt: iso(modifiedSec ?? 0), updatedAt: modifiedSec === null ? null : iso(modifiedSec) }),
    cancelledAt: (at: Date | null | "invalid") =>
      shop({ cancelledAt: at instanceof Date ? at.toISOString() : iso(0), updatedAt: at === null ? null : at === "invalid" ? "pas-une-date" : at.toISOString() }),
    reopenedAt: (at: Date) => shop({ displayFinancialStatus: "PENDING", updatedAt: at.toISOString() }),
    cancelledRefunded: (refunded: number) =>
      shop({
        cancelledAt: iso(+600),
        updatedAt: iso(+600),
        displayFinancialStatus: refunded >= 100 ? "REFUNDED" : refunded > 0 ? "PARTIALLY_REFUNDED" : "PAID",
        refundedTotal: refunded,
      }),
  },
];

async function ledger(sku: string) {
  const item = await prisma.inventoryItem.findFirstOrThrow({ where: { product: { sku } }, include: { movements: { orderBy: { createdAt: "asc" } } } });
  return { reserved: item.quantityReserved, onHand: item.quantityOnHand, movements: item.movements.map((m) => `${m.type}:${m.quantity}`) };
}
const theOrder = (source: "WOOCOMMERCE" | "SHOPIFY") => prisma.order.findFirstOrThrow({ where: { source } });

describe.each(PROVIDERS)("$name — import of an already-confirmed order", (p) => {
  it("« Toujours importer en Nouvelle » ON → NOUVELLE, nothing reserved", async () => {
    expect(await p.importOrder(p.confirmed(), ON)).toMatchObject({ outcome: "imported" });
    expect((await theOrder(p.source)).status).toBe("NOUVELLE");
    expect(await ledger(p.sku)).toEqual({ reserved: 0, onHand: 15, movements: [] });
  });

  it("OFF → CONFIRMEE with exactly its reservation (one RESERVATION movement, in the same transaction); the new-order alert stays", async () => {
    const teammate = await createTestUser({ role: "CONFIRMATION" });
    expect(await p.importOrder(p.confirmed(), OFF)).toMatchObject({ outcome: "imported" });
    expect((await theOrder(p.source)).status).toBe("CONFIRMEE");
    expect(await ledger(p.sku)).toEqual({ reserved: 2, onHand: 15, movements: ["RESERVATION:2"] });
    expect(await prisma.notification.count({ where: { userId: teammate.id, type: "NOUVELLE_COMMANDE" } })).toBe(1);
  });

  it("OFF but stock short → stays NOUVELLE with a reason, nothing reserved (never half-reserved)", async () => {
    await prisma.inventoryItem.updateMany({ where: { product: { sku: p.sku } }, data: { quantityOnHand: 1 } });
    const result = await p.importOrder(p.confirmed(), OFF);
    expect(result).toMatchObject({ outcome: "imported", reason: expect.stringContaining("stock insuffisant pour réserver") });
    expect((await theOrder(p.source)).status).toBe("NOUVELLE");
    expect(await ledger(p.sku)).toEqual({ reserved: 0, onHand: 1, movements: [] });
  });

  it("replaying the same snapshot: one order, one reservation — never twice", async () => {
    for (let i = 0; i < 3; i++) await p.importOrder(p.confirmed(), OFF);
    expect(await prisma.order.count({ where: { source: p.source } })).toBe(1);
    expect(await ledger(p.sku)).toEqual({ reserved: 2, onHand: 15, movements: ["RESERVATION:2"] });
  });
});

describe.each(PROVIDERS)("$name — failed orders, legacy reservations, double release", (p) => {
  it("a payment-failed order imports as NOUVELLE + paymentStatus ECHEC (never the delivery ECHEC), no stock effect; a later store cancellation releases nothing", async () => {
    await p.importOrder(p.failed(), ON);
    expect(await theOrder(p.source)).toMatchObject({ status: "NOUVELLE", paymentStatus: "ECHEC", shippedAt: null });
    expect(await ledger(p.sku)).toEqual({ reserved: 0, onHand: 15, movements: [] });
    await p.importOrder(p.cancelled(+600), ON);
    expect((await theOrder(p.source)).status).toBe("ANNULEE");
    expect(await ledger(p.sku)).toEqual({ reserved: 0, onHand: 15, movements: [] });
  });

  it("an order sitting in CONFIRMEE WITHOUT a reservation in its ledger (imported before this rule): a store cancellation releases nothing — another order's 3 reserved units stay", async () => {
    await p.importOrder(p.confirmed(), ON);
    const order = await theOrder(p.source);
    await prisma.order.update({ where: { id: order.id }, data: { status: "CONFIRMEE" } }); // legacy state, no RESERVATION movement
    await prisma.inventoryItem.updateMany({ where: { product: { sku: p.sku } }, data: { quantityReserved: 3 } });

    await p.importOrder(p.cancelled(+60), ON);
    expect((await theOrder(p.source)).status).toBe("ANNULEE");
    expect(await ledger(p.sku)).toEqual({ reserved: 3, onHand: 15, movements: [] });
  });

  it("two cancellation deliveries after a real reservation: one LIBERATION, never two", async () => {
    await p.importOrder(p.confirmed(), OFF);
    await p.importOrder(p.cancelled(+60), OFF);
    await p.importOrder(p.cancelled(+120), OFF);
    expect(await ledger(p.sku)).toEqual({ reserved: 0, onHand: 15, movements: ["RESERVATION:2", "LIBERATION:2"] });
  });
});

describe.each(PROVIDERS)("$name — cancellation date and event ordering", (p) => {
  it("a store cancellation records cancelledAt from the store's own time; a replay never moves it", async () => {
    await p.importOrder(p.confirmed(), ON);
    await p.importOrder(p.cancelled(-600), ON);
    const first = (await theOrder(p.source)).cancelledAt;
    expect(first).not.toBeNull();
    expect(Math.abs(first!.getTime() - (Date.now() - 600_000))).toBeLessThan(5_000);
    await p.importOrder(p.cancelled(-60), ON);
    expect((await theOrder(p.source)).cancelledAt).toEqual(first);
  });

  it("a store cancellation never undoes a NEWER manual confirmation; one newer than it is applied", async () => {
    await p.importOrder(p.confirmed(), OFF);
    const order = await theOrder(p.source);
    await prisma.order.update({ where: { id: order.id }, data: { confirmedAt: new Date() } }); // a person confirmed it in ASODITECH

    const stale = await p.importOrder(p.cancelled(-3600), OFF);
    expect(stale.reason).toContain("antérieure à la confirmation");
    expect((await theOrder(p.source)).status).toBe("CONFIRMEE");
    const unknown = await p.importOrder(p.cancelled(null), OFF);
    expect(unknown.reason).toContain("date de modification est inconnue");
    expect(await ledger(p.sku)).toMatchObject({ reserved: 2, movements: ["RESERVATION:2"] });

    await p.importOrder(p.cancelled(+600), OFF); // clearly newer: beyond the 2-minute tolerance
    expect((await theOrder(p.source)).status).toBe("ANNULEE");
    expect(await ledger(p.sku)).toMatchObject({ reserved: 0, movements: ["RESERVATION:2", "LIBERATION:2"] });
  });
});

describe("WooCommerce — stale reopen, delivery date, partial refund", () => {
  it("a stale « pending » delivery after the cancellation does not reopen it; a newer one does", async () => {
    await importWooOrder(woo({ status: "pending" }), actor, ON);
    await importWooOrder(woo({ status: "cancelled", date_modified_gmt: gmt(-600) }), actor, ON);
    const stale = await importWooOrder(woo({ status: "pending", date_modified_gmt: gmt(-3600) }), actor, ON);
    expect(stale.reason).toContain("antérieur à l'annulation");
    expect((await theOrder("WOOCOMMERCE")).status).toBe("ANNULEE");

    await importWooOrder(woo({ status: "pending", date_modified_gmt: gmt(+60) }), actor, ON);
    expect(await theOrder("WOOCOMMERCE")).toMatchObject({ status: "NOUVELLE", cancelledAt: null });
  });

  it("store « completed » on a shipped order records deliveredAt = date_completed_gmt; an existing date is never overwritten", async () => {
    await importWooOrder(woo({ status: "pending" }), actor, ON);
    const order = await theOrder("WOOCOMMERCE");
    await prisma.order.update({ where: { id: order.id }, data: { status: "EXPEDIEE", shippedAt: new Date() } });
    const completedAt = gmt(-1800);
    await importWooOrder(woo({ status: "completed", date_completed_gmt: completedAt, date_modified_gmt: gmt(-60) }), actor, ON);
    expect(await theOrder("WOOCOMMERCE")).toMatchObject({ status: "LIVREE", deliveredAt: new Date(`${completedAt}Z`) });

    // another order, delivery date already known (e.g. from the carrier): kept
    const known = new Date("2026-02-01T09:00:00Z");
    await prisma.order.update({ where: { id: order.id }, data: { status: "EXPEDIEE", deliveredAt: known } });
    await importWooOrder(woo({ status: "completed", date_completed_gmt: gmt(-10) }), actor, ON);
    expect((await theOrder("WOOCOMMERCE")).deliveredAt).toEqual(known);
  });

  it("a partial refund on an active order: one refund row with the amount, status kept, payment NOT marked refunded", async () => {
    await importWooOrder(woo({ status: "processing" }), actor, ON);
    await importWooOrder(woo({ status: "processing", refunds: [{ id: 9, total: "-20.00" }] }), actor, ON);
    const order = await prisma.order.findFirstOrThrow({ where: { source: "WOOCOMMERCE" }, include: { refunds: true } });
    expect(order.refunds.map((r) => [r.source, Number(r.amount)])).toEqual([["WOOCOMMERCE", 20]]);
    expect(order.status).toBe("NOUVELLE");
    expect(order.paymentStatus).not.toBe("REMBOURSE");
  });
});

describe("Shopify — shipped on first import, partial refund on an unshipped order", () => {
  it("IN_PROGRESS on first import: never auto-applied — NOUVELLE, no stock effect, workflow mismatch raised", async () => {
    const watcher = await createTestUser({ role: "MANAGER" });
    const result = await importShopifyOrder(shop({ displayFulfillmentStatus: "IN_PROGRESS" }), actor, ON);
    expect(result.reason).toContain("seule l'action \"Expédiée\"");
    expect((await theOrder("SHOPIFY")).status).toBe("NOUVELLE");
    expect(await ledger("THE-SH")).toEqual({ reserved: 0, onHand: 15, movements: [] });
    expect(await prisma.notification.count({ where: { userId: watcher.id, type: "INCOHERENCE_WORKFLOW" } })).toBe(1);
  });

  it("PARTIALLY_REFUNDED + UNFULFILLED on a held order: the refund is kept (partial, not REMBOURSE), status unchanged — not dropped", async () => {
    await importShopifyOrder(shop(), actor, ON);
    const result = await importShopifyOrder(shop({ displayFinancialStatus: "PARTIALLY_REFUNDED", refundedTotal: 20 }), actor, ON);
    expect(result).toMatchObject({ outcome: "updated", reason: expect.stringContaining("Statut inchangé") });
    const order = await prisma.order.findFirstOrThrow({ where: { source: "SHOPIFY" }, include: { refunds: true } });
    expect(order.refunds.map((r) => [r.source, Number(r.amount)])).toEqual([["SHOPIFY", 20]]);
    expect(order.status).toBe("NOUVELLE");
    expect(order.paymentStatus).not.toBe("REMBOURSE");
  });

  it("the same combination on an order we do not hold is still skipped (nothing invented)", async () => {
    expect(await importShopifyOrder(shop({ displayFinancialStatus: "PARTIALLY_REFUNDED", refundedTotal: 20 }), actor, ON)).toMatchObject({ outcome: "skipped" });
    expect(await prisma.order.count()).toBe(0);
  });
});

describe("tenant isolation", () => {
  it("another company's order with the same store id is never read, matched or changed", async () => {
    const B = "tenant-b-order-sync";
    await prismaBase.tenant.create({ data: { id: B, name: "B", slug: B } });
    const bCustomer = await prismaBase.customer.create({ data: { tenantId: B, fullName: "B", phone: "0600000000" } });
    const bOrder = await prismaBase.order.create({
      data: { tenantId: B, customerId: bCustomer.id, source: "WOOCOMMERCE", externalId: "7001", status: "CONFIRMEE", subtotal: 1, total: 1 },
    });
    await importWooOrder(woo({ status: "processing" }), actor, OFF);
    await importWooOrder(woo({ status: "cancelled", date_modified_gmt: gmt(+60) }), actor, OFF);
    expect(await prismaBase.order.findUniqueOrThrow({ where: { id: bOrder.id } })).toMatchObject({ status: "CONFIRMEE", cancelledAt: null, total: bOrder.total });
    expect(await prismaBase.order.count({ where: { externalId: "7001", source: "WOOCOMMERCE" } })).toBe(2);
  });
});

describe("duplicate refund delivery — the order-row lock is what prevents it (deterministic)", () => {
  it("a delivery arriving while another holds the order row waits, then sees the refund already written: one refund", async () => {
    await importWooOrder(woo({ status: "processing" }), actor, ON);
    const order = await theOrder("WOOCOMMERCE");
    let settled = false;
    let lockTaken!: () => void;
    const locked = new Promise<void>((resolve) => (lockTaken = resolve));
    let letGo!: () => void;
    const proceed = new Promise<void>((resolve) => (letGo = resolve));

    // Transaction A (the « other delivery »): takes the order row, waits, then writes the refund.
    const holder = prismaBase.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${order.id} FOR UPDATE`;
        lockTaken();
        await proceed;
        await tx.refund.create({ data: { tenantId: order.tenantId, orderId: order.id, amount: 50, reason: "Importé depuis WooCommerce", status: "COMPLETE", source: "WOOCOMMERCE" } });
      },
      { timeout: 30_000 }
    );
    await locked;

    // Delivery B, from the test's own (tenant) context, while A holds the row.
    const importRun = importWooOrder(woo({ status: "processing", refunds: [{ id: 9, total: "-50.00" }] }), actor, ON).finally(() => {
      settled = true;
    });
    // Wait on a CONDITION (B blocked on the row lock, or B already done — which is what
    // happens without the lock: B then writes its own refund before A's).
    for (let i = 0; i < 400 && !settled; i++) {
      const [{ waiting }] = await prismaBase.$queryRaw<{ waiting: bigint }[]>`SELECT count(*)::bigint AS waiting FROM pg_locks WHERE NOT granted`;
      if (waiting > BigInt(0)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    letGo();
    await holder;
    await importRun;

    const refunds = await prisma.refund.findMany({ where: { orderId: order.id } });
    expect(refunds.map((r) => Number(r.amount))).toEqual([50]);
  }, 40_000);
});

// ---------------------------------------------------------------------------
// « Synchroniser les commandes » refreshes held orders (ADR 0010/0030), with
// the same guards — local fakes for both stores.
// ---------------------------------------------------------------------------

describe("bulk « Synchroniser les commandes » refreshes orders already held", () => {
  it("WooCommerce: a held order cancelled on the store is updated by the sync (missed webhook recovered); no duplicate; a second run changes nothing; a transition that is always refused is not retried", async () => {
    const { installFakeWooCommerceServer, emptyFakeStore, FAKE_STORE_URL, FAKE_CONSUMER_KEY, FAKE_CONSUMER_SECRET } = await import("../helpers/fake-woocommerce");
    const { encryptSecret } = await import("@/lib/crypto");
    const { syncWooCommerceOrdersAction } = await import("@/actions/woocommerce");
    const state = emptyFakeStore();
    installFakeWooCommerceServer(state);
    await prisma.integration.create({
      data: {
        provider: "WOOCOMMERCE",
        status: "CONNECTE",
        config: { siteUrl: FAKE_STORE_URL },
        credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: FAKE_CONSUMER_KEY, apiSecret: FAKE_CONSUMER_SECRET })),
      },
    });
    const raw = (id: number, status: string, extra: Record<string, unknown> = {}) =>
      ({ ...JSON.parse(JSON.stringify(woo({ id, number: String(id), status }))), date_created: "2026-01-20T10:00:00", ...extra }) as never;

    await importWooOrder(woo({ id: 7001, number: "7001", status: "pending" }), actor, ON); // held, NOUVELLE
    await importWooOrder(woo({ id: 7002, number: "7002", status: "pending" }), actor, ON); // held, NOUVELLE
    state.orders = [
      raw(7001, "cancelled", { date_modified_gmt: gmt(+60) }), // webhook missed
      raw(7002, "processing"), // « Toujours importer en Nouvelle » blocks it every time
    ];

    const first = await syncWooCommerceOrdersAction();
    expect(first.ok && first.data.summary).toMatchObject({ updated: 1, imported: 0 });
    expect(await prisma.order.count({ where: { source: "WOOCOMMERCE" } })).toBe(2);
    expect(await prisma.order.findFirstOrThrow({ where: { externalId: "7001" } })).toMatchObject({ status: "ANNULEE", cancelledAt: expect.any(Date) });
    expect((await prisma.order.findFirstOrThrow({ where: { externalId: "7002" } })).status).toBe("NOUVELLE");

    const second = await syncWooCommerceOrdersAction();
    expect(second.ok && second.data.summary).toMatchObject({ updated: 0, imported: 0 });
    vi.unstubAllGlobals();
  });

  it("Shopify: same — a held order cancelled on Shopify is refreshed by the sync, partial refund included; second run unchanged", async () => {
    const { installFakeShopifyServer, emptyFakeShopifyStore, FAKE_SHOP_DOMAIN, FAKE_ACCESS_TOKEN } = await import("../helpers/fake-shopify");
    const { connectIntegrationAction } = await import("@/actions/integrations");
    const { syncShopifyOrdersAction } = await import("@/actions/shopify");
    vi.stubEnv("SHOPIFY_INTEGRATION_ENABLED", "true");
    const state = emptyFakeShopifyStore();
    installFakeShopifyServer(state);
    const fd = new FormData();
    for (const [k, v] of Object.entries({ provider: "SHOPIFY", siteUrl: FAKE_SHOP_DOMAIN, apiKey: FAKE_ACCESS_TOKEN, apiSecret: "" })) fd.set(k, v);
    expect(await connectIntegrationAction(fd)).toMatchObject({ ok: true });

    await importShopifyOrder(shop(), actor, ON); // held, NOUVELLE
    const base: FakeOrder = {
      id: "gid://shopify/Order/7001",
      name: "#7001",
      createdAt: "2026-01-20T10:00:00Z",
      displayFinancialStatus: "PARTIALLY_REFUNDED",
      displayFulfillmentStatus: "UNFULFILLED",
      total: 100,
      subtotal: 100,
      refundedTotal: 20,
      lineItems: [{ id: "gid://shopify/LineItem/1", title: "Thé S", sku: "THE-SH", quantity: 2, productId: "gid://shopify/Product/501", unitPrice: 50, discountedTotal: 100, originalTotal: 100 }],
    };
    state.orders = [base];
    const first = await syncShopifyOrdersAction();
    expect(first.ok && first.data.summary).toMatchObject({ updated: 1 });
    const order = await prisma.order.findFirstOrThrow({ where: { source: "SHOPIFY" }, include: { refunds: true } });
    expect(order.refunds.map((r) => Number(r.amount))).toEqual([20]);
    expect(order.status).toBe("NOUVELLE");

    state.orders = [{ ...base, cancelledAt: iso(+30), updatedAt: iso(+30) }];
    const second = await syncShopifyOrdersAction();
    expect(second.ok && second.data.summary).toMatchObject({ updated: 1 });
    expect(await prisma.order.findFirstOrThrow({ where: { source: "SHOPIFY" } })).toMatchObject({ status: "ANNULEE", cancelledAt: expect.any(Date) });

    const third = await syncShopifyOrdersAction();
    expect(third.ok && third.data.summary).toMatchObject({ updated: 0 });
    expect(await prisma.order.count({ where: { source: "SHOPIFY" } })).toBe(1);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});

// ---------------------------------------------------------------------------
// Owner decisions 2026-10-14 (docs/decisions/order-sync-open-decisions.md)
// ---------------------------------------------------------------------------

describe.each(PROVIDERS)("$name — §1 payment failure on an order already held", (p) => {
  it("held NOUVELLE, payment EN_ATTENTE → store reports the payment failed: payment ECHEC, status unchanged, no stock effect; a replay changes nothing", async () => {
    await p.importOrder(p.confirmed(), ON); // NOUVELLE
    const order = await theOrder(p.source);
    await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: "EN_ATTENTE" } });
    expect(await p.importOrder(p.failed(), ON)).toMatchObject({ outcome: "updated" });
    expect(await theOrder(p.source)).toMatchObject({ status: "NOUVELLE", paymentStatus: "ECHEC" });
    expect(await p.importOrder(p.failed(), ON)).toMatchObject({ outcome: "unchanged" });
    expect(await ledger(p.sku)).toEqual({ reserved: 0, onHand: 15, movements: [] });
  });

  it("held CONFIRMEE with its reservation: a store payment failure never demotes it nor releases stock; a payment already PAYE is never overwritten", async () => {
    await p.importOrder(p.confirmed(), OFF); // CONFIRMEE, 2 reserved
    const order = await theOrder(p.source);
    await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: "PAYE" } });
    await p.importOrder(p.failed(), OFF);
    expect(await theOrder(p.source)).toMatchObject({ status: "CONFIRMEE", paymentStatus: "PAYE" });
    expect(await ledger(p.sku)).toEqual({ reserved: 2, onHand: 15, movements: ["RESERVATION:2"] });
  });

  it("a legacy order already sitting in ECHEC (old import) stays ECHEC on a repeated failure — nothing shipped, reserved or invented", async () => {
    await p.importOrder(p.confirmed(), ON);
    const order = await theOrder(p.source);
    await prisma.order.update({ where: { id: order.id }, data: { status: "ECHEC", paymentStatus: "EN_ATTENTE" } }); // pre-2026-10-14 import
    await p.importOrder(p.failed(), ON);
    expect(await theOrder(p.source)).toMatchObject({ status: "ECHEC", paymentStatus: "ECHEC", shippedAt: null });
    expect(await ledger(p.sku)).toEqual({ reserved: 0, onHand: 15, movements: [] });
  });
});

describe("§1 legacy ECHEC never shipped — the retry is refused (no phantom stock consumption)", () => {
  async function legacyEchec() {
    await importWooOrder(woo({ status: "pending" }), actor, ON);
    const order = await theOrder("WOOCOMMERCE");
    await prisma.order.update({ where: { id: order.id }, data: { status: "ECHEC" } }); // imported « failed » before 2026-10-14
    await prisma.inventoryItem.updateMany({ where: { product: { sku: "THE-WC" } }, data: { quantityReserved: 3 } }); // another order's reservation
    return order;
  }

  it("ECHEC → EN_PREPARATION is refused with an audited reason; stock untouched; « Annuler » then « Rétablir » recovers it", async () => {
    const { updateOrderStatusAction, reopenOrderAction } = await import("@/actions/orders");
    const order = await legacyEchec();
    const fd = (fields: Record<string, string>) => {
      const f = new FormData();
      for (const [k, v] of Object.entries(fields)) f.set(k, v);
      return f;
    };

    const refused = await updateOrderStatusAction(fd({ id: order.id, status: "EN_PREPARATION" }));
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("jamais été expédiée") });
    expect((await theOrder("WOOCOMMERCE")).status).toBe("ECHEC");
    expect(await ledger("THE-WC")).toEqual({ reserved: 3, onHand: 15, movements: [] });
    expect(await prisma.auditEvent.findFirstOrThrow({ where: { action: "order.transition_refused", entityId: order.id } })).toMatchObject({
      metadata: { requestedStatus: "EN_PREPARATION", reason: "unshipped_echec_no_reservation" },
    });

    expect(await updateOrderStatusAction(fd({ id: order.id, status: "ANNULEE" }))).toMatchObject({ ok: true });
    expect(await ledger("THE-WC")).toEqual({ reserved: 3, onHand: 15, movements: [] }); // nothing to release
    expect(await reopenOrderAction(fd({ id: order.id }))).toMatchObject({ ok: true });
    expect((await theOrder("WOOCOMMERCE")).status).toBe("NOUVELLE");
  });

  it("a REAL failed delivery (shipped once) keeps its retry: ECHEC → EN_PREPARATION allowed, no second consumption", async () => {
    const { updateOrderStatusAction } = await import("@/actions/orders");
    const order = await legacyEchec();
    await prisma.order.update({ where: { id: order.id }, data: { shippedAt: new Date() } });
    const f = new FormData();
    f.set("id", order.id);
    f.set("status", "EN_PREPARATION");
    expect(await updateOrderStatusAction(f)).toMatchObject({ ok: true });
    expect(await ledger("THE-WC")).toEqual({ reserved: 3, onHand: 15, movements: [] });
  });

  it("not in « À expédier », and a carrier reporting an old parcel in transit cannot auto-ship it (order_blocked, no VENTE)", async () => {
    const { shippableOrderWhere } = await import("@/lib/packing");
    const { applyShipmentStatusTransition } = await import("@/lib/delivery");
    const order = await legacyEchec();
    expect(await prisma.order.count({ where: { id: order.id, ...shippableOrderWhere(false) } })).toBe(0);
    expect(await prisma.order.count({ where: { id: order.id, ...shippableOrderWhere(true) } })).toBe(0);

    const provider = await prisma.shippingProvider.create({ data: { name: "Transporteur" } });
    const shipment = await prisma.shipment.create({ data: { orderId: order.id, providerId: provider.id, status: "EN_ATTENTE" } }); // e.g. created before this rule
    const result = await applyShipmentStatusTransition({
      shipmentId: shipment.id,
      currentStatus: "EN_ATTENTE",
      orderId: order.id,
      currentOrderStatus: "ECHEC",
      newStatus: "EN_TRANSIT",
      updatedById: null,
    });
    expect(result).toMatchObject({ ok: false, reason: "order_blocked", message: expect.stringContaining("jamais été expédiée") });
    expect(await theOrder("WOOCOMMERCE")).toMatchObject({ status: "ECHEC", shippedAt: null });
    expect(await ledger("THE-WC")).toEqual({ reserved: 3, onHand: 15, movements: [] });
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).status).toBe("EN_ATTENTE");
  });
});

describe("§2 Shopify FULFILLED = shipped, never proof of delivery", () => {
  async function heldShopifyOrder(status: "EN_PREPARATION" | "EXPEDIEE" | "LIVREE") {
    await importShopifyOrder(shop(), actor, ON);
    const order = await theOrder("SHOPIFY");
    const agentUser = await createTestUser({ role: "CONFIRMATION" });
    const agent = await prisma.commissionAgent.create({ data: { userId: agentUser.id, ratePerOrder: 10 } });
    await prisma.order.update({
      where: { id: order.id },
      data: { status, confirmationAgentId: agent.id, confirmedAt: new Date(Date.now() - 86_400_000), ...(status !== "EN_PREPARATION" ? { shippedAt: new Date(Date.now() - 3_600_000) } : {}) },
    });
    return order;
  }

  it("held EXPEDIEE + FULFILLED: stays EXPEDIEE — no LIVREE, no deliveredAt, no commission, no false alert", async () => {
    const watcher = await createTestUser({ role: "MANAGER" });
    const order = await heldShopifyOrder("EXPEDIEE");
    await importShopifyOrder(shop({ displayFulfillmentStatus: "FULFILLED", updatedAt: iso(+600) }), actor, ON);
    expect(await theOrder("SHOPIFY")).toMatchObject({ status: "EXPEDIEE", deliveredAt: null });
    expect(await prisma.commissionEntry.count({ where: { orderId: order.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: watcher.id, type: "INCOHERENCE_WORKFLOW" } })).toBe(0);
  });

  it("held LIVREE (delivered by the carrier / staff) + FULFILLED: kept as is, no alert", async () => {
    const watcher = await createTestUser({ role: "MANAGER" });
    await heldShopifyOrder("LIVREE");
    await importShopifyOrder(shop({ displayFulfillmentStatus: "FULFILLED", updatedAt: iso(+600) }), actor, ON);
    expect((await theOrder("SHOPIFY")).status).toBe("LIVREE");
    expect(await prisma.notification.count({ where: { userId: watcher.id, type: "INCOHERENCE_WORKFLOW" } })).toBe(0);
  });

  it("held EN_PREPARATION + FULFILLED: never auto-shipped nor delivered (no stock consumed) — workflow mismatch raised for a person", async () => {
    const watcher = await createTestUser({ role: "MANAGER" });
    const order = await heldShopifyOrder("EN_PREPARATION");
    const result = await importShopifyOrder(shop({ displayFulfillmentStatus: "FULFILLED", updatedAt: iso(+600) }), actor, ON);
    expect(result.reason).toContain("seule l'action \"Expédiée\"");
    expect(await theOrder("SHOPIFY")).toMatchObject({ status: "EN_PREPARATION", shippedAt: null, deliveredAt: null });
    expect(await ledger("THE-SH")).toEqual({ reserved: 0, onHand: 15, movements: [] });
    expect(await prisma.commissionEntry.count({ where: { orderId: order.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: watcher.id, type: "INCOHERENCE_WORKFLOW" } })).toBe(1);
  });

  it("WooCommerce « completed » is unchanged: a shipped order becomes LIVREE", async () => {
    await importWooOrder(woo({ status: "pending" }), actor, ON);
    const order = await theOrder("WOOCOMMERCE");
    await prisma.order.update({ where: { id: order.id }, data: { status: "EXPEDIEE", shippedAt: new Date() } });
    await importWooOrder(woo({ status: "completed", date_modified_gmt: gmt(+600) }), actor, ON);
    expect((await theOrder("WOOCOMMERCE")).status).toBe("LIVREE");
  });
});

describe.each(PROVIDERS)("$name — §3 cancelled and refunded: payment REMBOURSE only when refunds cover the total", (p) => {
  const refundsOf = async (source: "WOOCOMMERCE" | "SHOPIFY") =>
    (await prisma.order.findFirstOrThrow({ where: { source }, include: { refunds: true } })).refunds.map((r) => [r.source, Number(r.amount), r.status]);

  it("held order cancelled AND fully refunded on the store → status ANNULEE, payment REMBOURSE, ONE refund row; duplicate deliveries change nothing", async () => {
    await p.importOrder(p.confirmed(), ON);
    for (let i = 0; i < 3; i++) await p.importOrder(p.cancelledRefunded(100), ON);
    expect(await theOrder(p.source)).toMatchObject({ status: "ANNULEE", paymentStatus: "REMBOURSE" });
    expect(await refundsOf(p.source)).toEqual([[p.source, 100, "COMPLETE"]]);
  });

  it("cancelled with a PARTIAL refund → ANNULEE, payment NOT REMBOURSE, refund kept partial", async () => {
    await p.importOrder(p.confirmed(), ON);
    await p.importOrder(p.cancelledRefunded(40), ON);
    const order = await theOrder(p.source);
    expect(order.status).toBe("ANNULEE");
    expect(order.paymentStatus).not.toBe("REMBOURSE");
    expect(await refundsOf(p.source)).toEqual([[p.source, 40, "COMPLETE"]]);
  });

  it("cancelled with NO refund → payment never inferred as refunded from the cancellation alone", async () => {
    await p.importOrder(p.confirmed(), ON);
    const before = (await theOrder(p.source)).paymentStatus;
    await p.importOrder(p.cancelledRefunded(0), ON);
    expect(await theOrder(p.source)).toMatchObject({ status: "ANNULEE", paymentStatus: before });
  });

  it("store partial refund + a COMPLETE refund recorded in ASODITECH only TOGETHER reach the total → never REMBOURSE automatically (may be the same money, decision 2026-10-14 bis §7); a refund still EN_ATTENTE does not count", async () => {
    await p.importOrder(p.confirmed(), ON);
    const order = await theOrder(p.source);
    await prisma.refund.create({ data: { orderId: order.id, amount: 60, status: "EN_ATTENTE", source: "INTERNE" } });
    await p.importOrder(p.cancelledRefunded(40), ON);
    expect((await theOrder(p.source)).paymentStatus).not.toBe("REMBOURSE"); // 40 COMPLETE + 60 pending
    await prisma.refund.updateMany({ where: { orderId: order.id, source: "INTERNE" }, data: { status: "COMPLETE" } });
    await p.importOrder(p.cancelledRefunded(40), ON);
    const after = await theOrder(p.source);
    expect(after.status).toBe("ANNULEE");
    expect(after.paymentStatus).not.toBe("REMBOURSE");
  });

  it("first import of an order already cancelled AND fully refunded → ANNULEE + REMBOURSE directly", async () => {
    await p.importOrder(p.cancelledRefunded(100), ON);
    expect(await theOrder(p.source)).toMatchObject({ status: "ANNULEE", paymentStatus: "REMBOURSE" });
    expect(await refundsOf(p.source)).toEqual([[p.source, 100, "COMPLETE"]]);
  });
});

describe.each(PROVIDERS)("$name — §4 clock tolerance (2 minutes) around a local decision — deterministic times", (p) => {
  // A fixed local decision time, whole seconds (WooCommerce *_gmt has 1 s precision).
  const T = new Date("2026-03-01T12:00:00Z");
  const at = (ms: number) => new Date(T.getTime() + ms);

  async function confirmedLocallyAt() {
    await p.importOrder(p.confirmed(), OFF); // CONFIRMEE, 2 reserved
    const order = await theOrder(p.source);
    await prisma.order.update({ where: { id: order.id }, data: { confirmedAt: T } });
    return order;
  }

  it.each([
    ["clearly older (−5 min) → stale, rejected", -300_000, "antérieure à la confirmation", "CONFIRMEE"],
    ["older boundary (−2 min exactly) → ambiguous, manual review", -120_000, "moins de 2 minutes", "CONFIRMEE"],
    ["−1 s → ambiguous", -1_000, "moins de 2 minutes", "CONFIRMEE"],
    ["same second → ambiguous", 0, "moins de 2 minutes", "CONFIRMEE"],
    ["+1 s → ambiguous", 1_000, "moins de 2 minutes", "CONFIRMEE"],
    ["newer boundary (+2 min exactly) → ambiguous, manual review", 120_000, "moins de 2 minutes", "CONFIRMEE"],
    ["+2 min 1 s → clearly newer, applied", 121_000, null, "ANNULEE"],
  ] as const)("store cancellation %s", async (_, offset, reasonPart, expectedStatus) => {
    const watcher = await createTestUser({ role: "MANAGER" });
    await confirmedLocallyAt();
    const result = await p.importOrder(p.cancelledAt(at(offset)), OFF);
    expect((await theOrder(p.source)).status).toBe(expectedStatus);
    expect((await theOrder(p.source)).confirmedAt).toEqual(T); // the local timestamp is never rewritten
    if (reasonPart) {
      expect(result.reason).toContain(reasonPart);
      expect(await ledger(p.sku)).toEqual({ reserved: 2, onHand: 15, movements: ["RESERVATION:2"] });
    } else {
      expect(await ledger(p.sku)).toEqual({ reserved: 0, onHand: 15, movements: ["RESERVATION:2", "LIBERATION:2"] });
    }
    // Manual review (ambiguous / unknown) alerts a person; a stale or applied event does not.
    const review = reasonPart === "moins de 2 minutes";
    expect(await prisma.notification.count({ where: { userId: watcher.id, type: "INCOHERENCE_WORKFLOW" } })).toBe(review ? 1 : 0);
  });

  it.each([
    ["missing", null],
    ["invalid", "invalid"],
  ] as const)("a %s store timestamp → ambiguous: refused for review, alerted, nothing released", async (_, value) => {
    const watcher = await createTestUser({ role: "MANAGER" });
    await confirmedLocallyAt();
    const result = await p.importOrder(p.cancelledAt(value), OFF);
    expect(result.reason).toContain("date de modification est inconnue");
    expect((await theOrder(p.source)).status).toBe("CONFIRMEE");
    expect(await ledger(p.sku)).toEqual({ reserved: 2, onHand: 15, movements: ["RESERVATION:2"] });
    expect(await prisma.notification.count({ where: { userId: watcher.id, type: "INCOHERENCE_WORKFLOW" } })).toBe(1);
  });

  it("store reopen after a local cancellation: within 2 min → review, not reopened; clearly newer → reopened; clearly older → stale", async () => {
    await p.importOrder(p.reopenedAt(at(-86_400_000)), ON); // NOUVELLE
    const order = await theOrder(p.source);
    await prisma.order.update({ where: { id: order.id }, data: { status: "ANNULEE", cancelledAt: T } });

    expect((await p.importOrder(p.reopenedAt(at(-300_000)), ON)).reason).toContain("antérieur à l'annulation");
    expect((await p.importOrder(p.reopenedAt(at(90_000)), ON)).reason).toContain("moins de 2 minutes");
    expect(await theOrder(p.source)).toMatchObject({ status: "ANNULEE", cancelledAt: T });
    await p.importOrder(p.reopenedAt(at(300_000)), ON);
    expect(await theOrder(p.source)).toMatchObject({ status: "NOUVELLE", cancelledAt: null });
  });
});
