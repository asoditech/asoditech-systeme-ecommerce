import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { importOrder as importWooOrder } from "@/lib/integrations/woocommerce/sync";
import { importOrder as importShopifyOrder } from "@/lib/integrations/shopify/sync";
import { wcOrderSchema } from "@/lib/integrations/woocommerce/types";
import { shopifyOrderSchema } from "@/lib/integrations/shopify/types";
import { createRefundAction, updateRefundStatusAction } from "@/actions/orders";
import { resetDb } from "../helpers/db";
import { createTestUser, loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { serializeOrder, type FakeOrder } from "../helpers/fake-shopify";

/**
 * Payment / refund safety (owner decisions 2026-10-14 bis,
 * docs/decisions/order-sync-open-decisions.md « Payment & refund identity »):
 * - a store payment-success report recovers ECHEC → PAYE only when clearly
 *   NEWER than the recorded failure (2-min tolerance), opt-in, never on a
 *   cancelled order, never while a refund is reported, idempotently;
 * - a payment change alone never confirms, reserves or ships;
 * - store refunds = one row per provider holding the store's cumulative
 *   total (duplicate deliveries never add), compared in cents;
 * - refunds recorded by hand on store orders are INTERNE, never assumed
 *   executed on the store, and never netted against a store refund that
 *   may be the same money — a person is alerted instead.
 * Deterministic store times: every event time is T + offset, T fixed.
 */

const actor = { type: "INTEGRATION" } as const;
const ON = { forceNouvelleOnFirstImport: true };
const T = new Date("2026-03-01T12:00:00.000Z");
const at = (seconds: number) => new Date(T.getTime() + seconds * 1000);
const wooTime = (d: Date) => d.toISOString().slice(0, 19); // *_gmt, no zone suffix

function woo(overrides: Record<string, unknown> = {}) {
  return wcOrderSchema.parse({
    id: 8001,
    number: "8001",
    status: "on-hold",
    date_created: "2026-03-01T11:00:00",
    total: "100.00",
    billing: { first_name: "Sara", last_name: "Amrani", phone: "0611223344" },
    shipping: {},
    line_items: [{ id: 1, name: "Thé", product_id: 501, sku: "THE-WC", quantity: 2, price: "50.00", subtotal: "100.00", total: "100.00" }],
    ...overrides,
  });
}

function shop(overrides: Partial<FakeOrder> = {}) {
  const fake: FakeOrder = {
    id: "gid://shopify/Order/8001",
    name: "#8001",
    createdAt: "2026-03-01T11:00:00Z",
    displayFinancialStatus: "PENDING",
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
    importOrder: (o: unknown) => importWooOrder(o as ReturnType<typeof woo>, actor, ON),
    pending: (when: Date | null) => woo({ status: "on-hold", date_modified_gmt: when ? wooTime(when) : undefined }),
    /** Payment failed on the store (`failed`), modified at `when`. */
    failed: (when: Date | null) => woo({ status: "failed", date_modified_gmt: when ? wooTime(when) : undefined }),
    /** Paid on the store (`date_paid` set), still on-hold — a pure payment fact. */
    paid: (when: Date | null, refunded = 0) =>
      woo({
        status: "on-hold",
        date_paid: "2026-03-01T12:00:00",
        date_modified_gmt: when ? wooTime(when) : undefined,
        refunds: refunded > 0 ? [{ id: 91, total: `-${refunded.toFixed(2)}` }] : [],
      }),
    /** Cancelled on the store yet reported paid there. */
    paidCancelled: (when: Date) => woo({ status: "cancelled", date_paid: "2026-03-01T12:00:00", date_modified_gmt: wooTime(when) }),
    /** Cancelled on the store with `refunded` refunded there (several refund entries allowed). */
    cancelled: (when: Date, refunds: number[]) =>
      woo({ status: "cancelled", date_modified_gmt: wooTime(when), refunds: refunds.map((r, i) => ({ id: 100 + i, total: `-${r.toFixed(2)}` })) }),
  },
  {
    name: "Shopify",
    source: "SHOPIFY" as const,
    sku: "THE-SH",
    importOrder: (o: unknown) => importShopifyOrder(o as ReturnType<typeof shop>, actor, ON),
    pending: (when: Date | null) => shop({ displayFinancialStatus: "PENDING", updatedAt: when ? when.toISOString() : null }),
    failed: (when: Date | null) => shop({ displayFinancialStatus: "EXPIRED", updatedAt: when ? when.toISOString() : null }),
    paid: (when: Date | null, refunded = 0) =>
      shop({ displayFinancialStatus: refunded > 0 ? "PARTIALLY_REFUNDED" : "PAID", updatedAt: when ? when.toISOString() : null, refundedTotal: refunded }),
    paidCancelled: (when: Date) => shop({ displayFinancialStatus: "PAID", cancelledAt: when.toISOString(), updatedAt: when.toISOString() }),
    cancelled: (when: Date, refunds: number[]) => {
      const total = refunds.reduce((s, r) => s + r, 0);
      return shop({
        cancelledAt: when.toISOString(),
        updatedAt: when.toISOString(),
        displayFinancialStatus: total >= 100 ? "REFUNDED" : total > 0 ? "PARTIALLY_REFUNDED" : "PAID",
        refundedTotal: total,
      });
    },
  },
];

const setOptIn = (on: boolean) =>
  prisma.businessSettings.upsert({ where: { tenantId: "default" }, update: { autoPaymentFromStore: on }, create: { autoPaymentFromStore: on } });
const theOrder = (source: "WOOCOMMERCE" | "SHOPIFY") => prisma.order.findFirstOrThrow({ where: { source } });
let teammateId = "";
/** « Paiement à vérifier » alerts received by one teammate (one row per recipient). */
const reviewAlerts = (orderId: string) =>
  prisma.notification.count({ where: { userId: teammateId, type: "PROBLEME_PAIEMENT", entityId: orderId, title: { startsWith: "Paiement à vérifier" } } });
const recoveryAudits = (orderId: string) =>
  prisma.auditEvent.count({ where: { entityType: "Order", entityId: orderId, metadata: { path: ["reason"], equals: "store_reported_paid_after_failure" } } });

async function ledger(sku: string) {
  const item = await prisma.inventoryItem.findFirstOrThrow({ where: { product: { sku } }, include: { movements: true } });
  return { reserved: item.quantityReserved, onHand: item.quantityOnHand, movements: item.movements.length };
}

const fd = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  await loginAsTestUser({ role: "ADMIN" });
  // A teammate who receives alerts (notifications skip nobody here: the actor is the integration).
  teammateId = (await createTestUser({ role: "MANAGER" })).id;
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
});

describe.each(PROVIDERS)("$name — store payment success after a payment failure (ECHEC → PAYE)", (p) => {
  it("clearly newer paid report → PAYE once; status, stock and shipments untouched; one audited recovery", async () => {
    await setOptIn(true);
    await p.importOrder(p.failed(at(0)));
    const order = await theOrder(p.source);
    expect(order).toMatchObject({ status: "NOUVELLE", paymentStatus: "ECHEC" });
    // The failure is recorded with the store's own time.
    const failure = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: order.id, newValue: { path: ["paymentStatus"], equals: "ECHEC" } } });
    expect((failure.metadata as { storeModifiedAt?: string }).storeModifiedAt).toBe(at(0).toISOString());
    const before = await ledger(p.sku);

    await p.importOrder(p.paid(at(300)));
    const after = await theOrder(p.source);
    expect(after.paymentStatus).toBe("PAYE");
    // Payment only: never confirmed, nothing reserved, nothing shipped.
    expect(after.status).toBe("NOUVELLE");
    expect(after.confirmedAt).toBeNull();
    expect(await ledger(p.sku)).toEqual(before);
    expect(await prisma.shipment.count()).toBe(0);
    expect(await recoveryAudits(order.id)).toBe(1);

    // Duplicate delivery of the same paid report, then a replayed (old) failure: no change, no second audit.
    await p.importOrder(p.paid(at(300)));
    await p.importOrder(p.failed(at(0)));
    expect((await theOrder(p.source)).paymentStatus).toBe("PAYE");
    expect(await recoveryAudits(order.id)).toBe(1);
    expect(await reviewAlerts(order.id)).toBe(0);
  });

  it("failure reported on an order already held (EN_ATTENTE → ECHEC) is ordered the same way", async () => {
    await setOptIn(true);
    await p.importOrder(p.pending(at(-600)));
    await p.importOrder(p.failed(at(0)));
    const order = await theOrder(p.source);
    expect(order.paymentStatus).toBe("ECHEC");
    await p.importOrder(p.paid(at(121)));
    expect((await theOrder(p.source)).paymentStatus).toBe("PAYE");
  });

  it("« Paiement confirmé par la boutique » OFF → ECHEC kept", async () => {
    await p.importOrder(p.failed(at(0)));
    await p.importOrder(p.paid(at(300)));
    const order = await theOrder(p.source);
    expect(order.paymentStatus).toBe("ECHEC");
    expect(await recoveryAudits(order.id)).toBe(0);
  });

  it("out of order: a paid report OLDER than the failure is rejected as stale (no alert)", async () => {
    await setOptIn(true);
    await p.importOrder(p.failed(at(0)));
    const result = await p.importOrder(p.paid(at(-300)));
    const order = await theOrder(p.source);
    expect(order.paymentStatus).toBe("ECHEC");
    expect(result.reason).toContain("antérieur à l'échec de paiement");
    expect(await reviewAlerts(order.id)).toBe(0);
  });

  it.each([
    ["inside the 2-minute window (+60 s)", 60],
    ["exactly at the boundary (+120 s, inclusive)", 120],
    ["inside the window, before the failure (−90 s)", -90],
  ])("%s → ECHEC kept, left for review with an alert", async (_label, offset) => {
    await setOptIn(true);
    await p.importOrder(p.failed(at(0)));
    const result = await p.importOrder(p.paid(at(offset)));
    const order = await theOrder(p.source);
    expect(order.paymentStatus).toBe("ECHEC");
    expect(result.reason).toContain("moins de 2 minutes");
    expect(await reviewAlerts(order.id)).toBe(1);
  });

  it("missing store time on the paid report → review, unchanged", async () => {
    await setOptIn(true);
    await p.importOrder(p.failed(at(0)));
    await p.importOrder(p.paid(null));
    const order = await theOrder(p.source);
    expect(order.paymentStatus).toBe("ECHEC");
    expect(await reviewAlerts(order.id)).toBe(1);
  });

  it("legacy ECHEC with no recorded failure time → review, unchanged", async () => {
    await setOptIn(true);
    await p.importOrder(p.pending(at(-600)));
    const order = await theOrder(p.source);
    await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: "ECHEC" } }); // set before this rule: no audit
    await p.importOrder(p.paid(at(3600)));
    expect((await theOrder(p.source)).paymentStatus).toBe("ECHEC");
    expect(await reviewAlerts(order.id)).toBe(1);
  });

  it("a cancelled order is never recovered automatically (review)", async () => {
    await setOptIn(true);
    await p.importOrder(p.failed(at(0)));
    const order = await theOrder(p.source);
    await p.importOrder(p.paidCancelled(at(300)));
    expect(await theOrder(p.source)).toMatchObject({ status: "ANNULEE", paymentStatus: "ECHEC" });
    expect(await reviewAlerts(order.id)).toBe(1);
  });

  it("a paid report that also carries a refund never recovers the payment", async () => {
    await setOptIn(true);
    await p.importOrder(p.failed(at(0)));
    await p.importOrder(p.paid(at(300), 30));
    const order = await theOrder(p.source);
    expect(order.paymentStatus).toBe("ECHEC");
    expect(await recoveryAudits(order.id)).toBe(0);
  });
});

describe.each(PROVIDERS)("$name — store refunds: one cumulative row, cents, duplicates", (p) => {
  it("duplicate deliveries never add; partial then full rewrites the same row; full on a cancelled order → REMBOURSE", async () => {
    await p.importOrder(p.pending(at(-600)));
    await p.importOrder(p.cancelled(at(0), [40]));
    await p.importOrder(p.cancelled(at(0), [40])); // duplicate delivery
    const order = await theOrder(p.source);
    let refunds = await prisma.refund.findMany({ where: { orderId: order.id } });
    expect(refunds.map((r) => [r.source, r.amount.toString()])).toEqual([[p.source, "40"]]);
    expect(order).toMatchObject({ status: "ANNULEE" });
    expect(order.paymentStatus).not.toBe("REMBOURSE"); // partial stays partial

    await p.importOrder(p.cancelled(at(60), [40, 60]));
    refunds = await prisma.refund.findMany({ where: { orderId: order.id } });
    expect(refunds.map((r) => r.amount.toString())).toEqual(["100"]);
    expect(await theOrder(p.source)).toMatchObject({ status: "ANNULEE", paymentStatus: "REMBOURSE" });
  });

  it("cents: refunds summing to the total through float-unsafe parts still cover it exactly", async () => {
    await p.importOrder(p.pending(at(-600)));
    await p.importOrder(p.cancelled(at(0), [33.33, 33.33, 33.34]));
    const order = await theOrder(p.source);
    expect((await prisma.refund.findFirstOrThrow({ where: { orderId: order.id } })).amount.toString()).toBe("100");
    expect(order.paymentStatus).toBe("REMBOURSE");
  });
});

describe.each(PROVIDERS)("$name — refunds recorded by hand on a store order", (p) => {
  it("is INTERNE, audited as manual and NOT executed on the store; capped in cents against the store's refund", async () => {
    await p.importOrder(p.cancelled(at(0), [60]));
    const order = await theOrder(p.source);

    const tooMuch = await createRefundAction(fd({ orderId: order.id, amount: "40.01", reason: "Geste commercial" }));
    expect(tooMuch).toMatchObject({ ok: false, error: expect.stringContaining("40.00 MAD restants") });

    const ok = await createRefundAction(fd({ orderId: order.id, amount: "40", reason: "Geste commercial" }));
    expect(ok.ok).toBe(true);
    const manual = await prisma.refund.findFirstOrThrow({ where: { orderId: order.id, source: "INTERNE" } });
    expect(manual.amount.toString()).toBe("40");
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: order.id, action: "order.refund.created" } });
    expect(audit.metadata).toMatchObject({ refundOrigin: "MANUEL", orderSource: p.source, executedOnStore: false });
    // Store refund + manual refund: possibly the same money → a person is alerted.
    expect(await reviewAlerts(order.id)).toBe(1);
  });

  it("store refund + manual refund that only TOGETHER reach the total → never REMBOURSE automatically (ambiguous), alerted", async () => {
    await p.importOrder(p.pending(at(-600)));
    const order = await theOrder(p.source);
    expect((await createRefundAction(fd({ orderId: order.id, amount: "50" }))).ok).toBe(true);
    await prisma.refund.updateMany({ where: { orderId: order.id, source: "INTERNE" }, data: { status: "COMPLETE" } });
    expect(await reviewAlerts(order.id)).toBe(0); // no store refund yet: nothing ambiguous

    await p.importOrder(p.cancelled(at(0), [50]));
    const after = await theOrder(p.source);
    expect(after.status).toBe("ANNULEE");
    expect(after.paymentStatus).not.toBe("REMBOURSE");
    expect(await prisma.refund.count({ where: { orderId: order.id } })).toBe(2);
    expect(await reviewAlerts(order.id)).toBe(1);
  });

  it("the store's refund ALONE covering the total is unambiguous → REMBOURSE (manual row still flagged)", async () => {
    await p.importOrder(p.pending(at(-600)));
    const order = await theOrder(p.source);
    expect((await createRefundAction(fd({ orderId: order.id, amount: "30" }))).ok).toBe(true);
    await p.importOrder(p.cancelled(at(0), [100]));
    expect(await theOrder(p.source)).toMatchObject({ status: "ANNULEE", paymentStatus: "REMBOURSE" });
    expect(await reviewAlerts(order.id)).toBe(1);
  });
});

describe.each(PROVIDERS)("$name — approving a refund in ASODITECH (updateRefundStatusAction → COMPLETE)", (p) => {
  /** Records a manual refund and walks it EN_ATTENTE → APPROUVE → COMPLETE through the real action. */
  async function completeManualRefund(orderId: string, amount: string) {
    const created = await createRefundAction(fd({ orderId, amount }));
    if (!created.ok) throw new Error(`setup failed: ${created.error}`);
    expect((await updateRefundStatusAction(fd({ id: created.data.id, status: "APPROUVE" }))).ok).toBe(true);
    expect((await updateRefundStatusAction(fd({ id: created.data.id, status: "COMPLETE" }))).ok).toBe(true);
    return created.data.id;
  }
  const completionAudit = (orderId: string) =>
    prisma.auditEvent.findFirstOrThrow({
      where: { entityId: orderId, action: "order.refund.status_changed", newValue: { path: ["status"], equals: "COMPLETE" } },
      orderBy: { createdAt: "desc" },
    });

  it("a partial manual refund reaching COMPLETE never marks the order REMBOURSE", async () => {
    await p.importOrder(p.pending(at(-600)));
    const order = await theOrder(p.source);
    await completeManualRefund(order.id, "40");
    expect((await theOrder(p.source)).paymentStatus).not.toBe("REMBOURSE");
    expect((await completionAudit(order.id)).metadata).toMatchObject({ refundCoverage: "partial", orderMarkedRefunded: false, executedOnStore: false });
  });

  it("a manual refund + a store refund that only TOGETHER reach the total → not REMBOURSE (ambiguous), alerted", async () => {
    await p.importOrder(p.cancelled(at(0), [50]));
    const order = await theOrder(p.source);
    expect(order.paymentStatus).not.toBe("REMBOURSE");
    await completeManualRefund(order.id, "50");
    const after = await theOrder(p.source);
    expect(after.paymentStatus).not.toBe("REMBOURSE");
    expect(after.status).toBe("ANNULEE");
    expect((await completionAudit(order.id)).metadata).toMatchObject({ refundCoverage: "ambiguous", orderMarkedRefunded: false });
    expect(await reviewAlerts(order.id)).toBe(1);
  });

  it("manual refunds that cover the total on their own (60 + 40, cents) → REMBOURSE on the completing approval only", async () => {
    await p.importOrder(p.pending(at(-600)));
    const order = await theOrder(p.source);
    await completeManualRefund(order.id, "60");
    expect((await theOrder(p.source)).paymentStatus).not.toBe("REMBOURSE");
    await completeManualRefund(order.id, "40");
    expect((await theOrder(p.source)).paymentStatus).toBe("REMBOURSE");
    expect((await completionAudit(order.id)).metadata).toMatchObject({ refundCoverage: "covered", orderMarkedRefunded: true, executedOnStore: false });
    // Recorded and completed in ASODITECH only: still INTERNE rows, no store row created.
    expect(await prisma.refund.count({ where: { orderId: order.id, source: { not: "INTERNE" } } })).toBe(0);
  });

  it("approving the same refund twice is refused and changes nothing (no second audit)", async () => {
    await p.importOrder(p.pending(at(-600)));
    const order = await theOrder(p.source);
    const id = await completeManualRefund(order.id, "40");
    const audits = await prisma.auditEvent.count({ where: { entityId: order.id, action: "order.refund.status_changed" } });
    const again = await updateRefundStatusAction(fd({ id, status: "COMPLETE" }));
    expect(again).toMatchObject({ ok: false, error: expect.stringContaining("Transition de statut invalide") });
    expect((await theOrder(p.source)).paymentStatus).not.toBe("REMBOURSE");
    expect(await prisma.auditEvent.count({ where: { entityId: order.id, action: "order.refund.status_changed" } })).toBe(audits);
  });
});
