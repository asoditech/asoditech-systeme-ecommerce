import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { getCurrentUser, createSession, type CurrentUser } from "@/lib/auth/session";
import { STORE_MANAGER_DENIES } from "@/lib/auth/store-manager-profile";
import { analyticsAccess } from "@/lib/analytics/access";
import { analyticsContext } from "@/lib/analytics/context";
import { resolveAnalyticsPeriod, meaningfulDelta } from "@/lib/analytics/period";
import { parseAnalyticsFilters, type AnalyticsFilters } from "@/lib/analytics/filters";
import { getOnlineOverview, getConfirmationAnalytics, getDeliveryAnalytics, getOnlineSourceFunnel, getOnlineRevenueSeries } from "@/lib/analytics/queries/online";
import { getOnlineProductPerformance, getStoreProductPerformance } from "@/lib/analytics/queries/products";
import { getCommissionAnalytics } from "@/lib/analytics/queries/commissions";
import { getStoreOverview } from "@/lib/analytics/queries/store";
import { createSaleAction } from "@/actions/sales";
import { createOrderAction, updateOrderStatusAction } from "@/actions/orders";
import { recordConfirmationAttemptAction } from "@/actions/order-confirmation";
import { GET as exportAnalytics } from "@/app/(protected)/analyses/export/[type]/route";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { runWithTenant } from "@/lib/tenant/context";
import { createTestUser, grantChannelAccess, grantLocationAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { RedirectSignal } from "../setup";

/**
 * Analytics & performance intelligence — docs/adr/0051. Every expected
 * number below is derived by hand from the fixture (see `onlineWorld`), so a
 * definition change fails loudly instead of drifting silently.
 */

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  await setTestBusinessMode("ONLINE_AND_OFFLINE");
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

const fd = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const at = (month: number, day: number, hour = 10) => new Date(2026, month - 1, day, hour, 0, 0);
const MARCH = resolveAnalyticsPeriod({ from: "2026-03-01", to: "2026-03-31" });
const FEBRUARY = resolveAnalyticsPeriod({ from: "2026-02-01", to: "2026-02-28" });
const NO_FILTER: AnalyticsFilters = {};

async function as(user: { id: string }): Promise<CurrentUser> {
  mockCookieStore.clear();
  await createSession(user.id);
  return (await getCurrentUser())!;
}

/**
 * Online fixture (tenant « default »), March 2026:
 *   O1 WooCommerce  LIVREE    placed 03-02 10h, confirmed 12h (A), shipped 03-03, delivered 03-05 — 300 (2 × variation 42)
 *   O2 WhatsApp     ECHEC     placed 03-04 08h, no-answer (A) 09h, confirmed 12h (B), shipped 03-05 (Ozon) — 200
 *   O3 Instagram    RETOUR    placed 03-06 08h, confirmed 14h (B), shipped 03-07, delivered 03-08, returned 03-10 — 150
 *   O4 Shopify      NOUVELLE  placed 03-10, busy (A) — 100
 *   O5 Téléphone    ANNULEE   placed 03-12, cancelled on the call (B) — 120
 *   O6 WooCommerce  CONFIRMEE placed 03-15 10h, confirmedAt 14h with NO attempt (import) — 80
 *   O7 WooCommerce  LIVREE    placed 02-20 (February!), shipped 03-01, delivered 03-02 (Ozon) — 500
 * O1 also carries a later failed API shipment that never reached a carrier.
 * O1 is created by `creator` and attributed to commission agent X — neither
 * ever recorded an attempt.
 */
async function onlineWorld() {
  const category = await prisma.category.create({ data: { name: "Chaussures", slug: "chaussures" } });
  const product = await prisma.product.create({ data: { name: "Basket", sku: "AN-1", price: 100, cost: 40, status: "ACTIF", categoryId: category.id } });
  const variation = await prisma.productVariation.create({ data: { productId: product.id, sku: "AN-1-42", attributes: { Taille: "42" } } });
  const customer = await prisma.customer.create({ data: { fullName: "Client", phone: "0600000000" } });
  const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt", isDefault: true } });
  const amana = await prisma.shippingProvider.create({ data: { name: "Amana", type: "MANUEL" } });
  const ozon = await prisma.shippingProvider.create({ data: { name: "Ozon", type: "MANUEL" } });
  const apiCarrier = await prisma.shippingProvider.create({ data: { name: "API Carrier", type: "API" } });

  const confirmerA = await createTestUser({ role: "CONFIRMATION" });
  const confirmerB = await createTestUser({ role: "CONFIRMATION" });
  const creator = await createTestUser({ role: "MANAGER" });
  const agentUserX = await createTestUser({ role: "CONFIRMATION" });
  const agentUserY = await createTestUser({ role: "CONFIRMATION" });
  const agentX = await prisma.commissionAgent.create({ data: { userId: agentUserX.id, ratePerOrder: 10 } });
  const agentY = await prisma.commissionAgent.create({ data: { userId: agentUserY.id, ratePerOrder: 15, isActive: false } });

  const order = (o: {
    source: "WOOCOMMERCE" | "SHOPIFY" | "INTERNE";
    channel?: "WHATSAPP" | "INSTAGRAM" | "TELEPHONE";
    status: "NOUVELLE" | "CONFIRMEE" | "LIVREE" | "ECHEC" | "RETOUR" | "ANNULEE";
    total: number;
    qty: number;
    placedAt: Date;
    confirmedAt?: Date;
    shippedAt?: Date;
    deliveredAt?: Date;
    withVariation?: boolean;
  }) =>
    prisma.order.create({
      data: {
        customerId: customer.id,
        source: o.source,
        channel: o.channel ?? null,
        externalId: o.source === "INTERNE" ? null : randomUUID(),
        status: o.status,
        subtotal: o.total,
        total: o.total,
        placedAt: o.placedAt,
        confirmedAt: o.confirmedAt ?? null,
        shippedAt: o.shippedAt ?? null,
        deliveredAt: o.deliveredAt ?? null,
        createdById: creator.id,
        confirmationAgentId: agentX.id,
        items: {
          create: [
            {
              productId: product.id,
              variationId: o.withVariation ? variation.id : null,
              nameSnapshot: "Basket",
              skuSnapshot: o.withVariation ? "AN-1-42" : "AN-1",
              unitPrice: o.total / o.qty,
              quantity: o.qty,
              total: o.total,
              costSnapshot: 40,
            },
          ],
        },
      },
      include: { items: true },
    });

  const O1 = await order({ source: "WOOCOMMERCE", status: "LIVREE", total: 300, qty: 2, withVariation: true, placedAt: at(3, 2, 10), confirmedAt: at(3, 2, 12), shippedAt: at(3, 3, 10), deliveredAt: at(3, 5, 10) });
  const O2 = await order({ source: "INTERNE", channel: "WHATSAPP", status: "ECHEC", total: 200, qty: 1, placedAt: at(3, 4, 8), confirmedAt: at(3, 4, 12), shippedAt: at(3, 5, 8) });
  const O3 = await order({ source: "INTERNE", channel: "INSTAGRAM", status: "RETOUR", total: 150, qty: 1, placedAt: at(3, 6, 8), confirmedAt: at(3, 6, 14), shippedAt: at(3, 7, 10), deliveredAt: at(3, 8, 10) });
  const O4 = await order({ source: "SHOPIFY", status: "NOUVELLE", total: 100, qty: 1, placedAt: at(3, 10, 10) });
  const O5 = await order({ source: "INTERNE", channel: "TELEPHONE", status: "ANNULEE", total: 120, qty: 1, placedAt: at(3, 12, 10) });
  const O6 = await order({ source: "WOOCOMMERCE", status: "CONFIRMEE", total: 80, qty: 1, placedAt: at(3, 15, 10), confirmedAt: at(3, 15, 14) });
  const O7 = await order({ source: "WOOCOMMERCE", status: "LIVREE", total: 500, qty: 5, placedAt: at(2, 20, 10), confirmedAt: at(2, 21, 10), shippedAt: at(3, 1, 10), deliveredAt: at(3, 2, 10) });

  const attempt = (orderId: string, user: { id: string }, outcome: "CONFIRME" | "PAS_DE_REPONSE" | "OCCUPE" | "ANNULE", createdAt: Date) =>
    prisma.orderConfirmationAttempt.create({ data: { orderId, agentUserId: user.id, outcome, createdAt } });
  await attempt(O1.id, confirmerA, "CONFIRME", at(3, 2, 12));
  await attempt(O2.id, confirmerA, "PAS_DE_REPONSE", at(3, 4, 9));
  await attempt(O2.id, confirmerB, "CONFIRME", at(3, 4, 12));
  await attempt(O3.id, confirmerB, "CONFIRME", at(3, 6, 14));
  await attempt(O4.id, confirmerA, "OCCUPE", at(3, 10, 11));
  await attempt(O5.id, confirmerB, "ANNULE", at(3, 12, 11));
  await attempt(O7.id, confirmerA, "CONFIRME", at(2, 21, 10)); // February — outside March

  const shipment = (orderId: string, providerId: string, status: "LIVRE" | "ECHEC" | "RETOURNE", createdAt: Date, externalId: string | null = null) =>
    prisma.shipment.create({ data: { orderId, providerId, status, createdAt, externalId } });
  await shipment(O1.id, amana.id, "LIVRE", at(3, 3, 9));
  await shipment(O1.id, apiCarrier.id, "ECHEC", at(3, 3, 11)); // API creation failure — never reached a carrier
  await shipment(O2.id, ozon.id, "ECHEC", at(3, 5, 7));
  await shipment(O3.id, amana.id, "RETOURNE", at(3, 7, 9));
  await shipment(O7.id, ozon.id, "LIVRE", at(3, 1, 9));

  await prisma.orderReturn.create({
    data: {
      orderId: O3.id,
      idempotencyKey: randomUUID(),
      receivedAt: at(3, 10, 10),
      lines: { create: [{ orderItemId: O3.items[0].id, nameSnapshot: "Basket", skuSnapshot: "AN-1", quantitySellable: 1, quantityDamaged: 0, warehouseId: warehouse.id }] },
    },
  });
  await prisma.refund.create({ data: { orderId: O3.id, amount: 150, status: "COMPLETE" } });
  await prisma.refund.create({ data: { orderId: O1.id, amount: 50, status: "EN_ATTENTE" } }); // not completed — never counted

  const entry = (agentId: string, orderId: string, type: "EARNED" | "REVERSED", amount: number, createdAt: Date) =>
    prisma.commissionEntry.create({ data: { agentId, orderId, type, amount, rateApplied: Math.abs(amount), createdAt } });
  await entry(agentX.id, O1.id, "EARNED", 10, at(3, 5, 10));
  await entry(agentX.id, O3.id, "EARNED", 10, at(3, 8, 10));
  await entry(agentX.id, O3.id, "REVERSED", -10, at(3, 10, 10));
  await entry(agentY.id, O7.id, "EARNED", 15, at(3, 2, 10));
  await entry(agentX.id, O6.id, "EARNED", 10, at(2, 28, 10)); // February — outside March

  return { category, product, variation, customer, warehouse, amana, ozon, confirmerA, confirmerB, creator, agentUserX, agentUserY, agentX, agentY, O1, O2, O3, O4, O5, O6, O7 };
}

/** Two stores (A, B) sharing one store channel, one sale at each, sold now. */
async function storeWorld() {
  const whA = await prisma.warehouse.create({ data: { name: "Magasin A", type: "MAGASIN" } });
  const whB = await prisma.warehouse.create({ data: { name: "Magasin B", type: "MAGASIN" } });
  const shared = await prisma.salesChannel.create({ data: { name: "Boutiques", kind: "OFFLINE" } });
  for (const wh of [whA, whB]) await prisma.salesChannelLocation.create({ data: { salesChannelId: shared.id, warehouseId: wh.id } });
  const product = await prisma.product.create({ data: { name: "Sac", sku: "ST-1", price: 200, cost: 80, status: "ACTIF" } });
  await prisma.productSalesChannel.create({ data: { productId: product.id, salesChannelId: shared.id } });
  for (const wh of [whA, whB]) await prisma.inventoryItem.create({ data: { warehouseId: wh.id, productId: product.id, quantityOnHand: 10 } });
  const admin = await createTestUser({ role: "ADMIN" });
  await as(admin);
  const sale = async (wh: { id: string }, qty: number) => {
    const r = await createSaleAction({ salesChannelId: shared.id, warehouseId: wh.id, idempotencyKey: randomUUID(), lines: [{ productId: product.id, quantity: qty }], payments: [{ method: "ESPECES", amount: 200 * qty }] });
    if (!r.ok) throw new Error(r.error);
    return r.data.id;
  };
  await sale(whA, 1);
  await sale(whB, 2);
  mockCookieStore.clear();
  return { whA, whB, shared, product, admin };
}

async function storeManager(w: Awaited<ReturnType<typeof storeWorld>>, locations: { id: string }[]) {
  const u = await createTestUser({ role: "MANAGER", channels: "none" });
  await grantChannelAccess(u.id, w.shared.id);
  await grantLocationAccess(u.id, locations.map((l) => l.id));
  for (const p of STORE_MANAGER_DENIES) await prisma.userPermissionOverride.create({ data: { userId: u.id, permission: p, effect: "DENY" } });
  return u;
}

const SEVEN_DAYS = resolveAnalyticsPeriod({ period: "7d" });

async function csv(type: string, query = "") {
  const res = await exportAnalytics(new Request(`http://localhost/analyses/export/${type}?${query}`), { params: Promise.resolve({ type }) });
  return { status: res.status, body: res.status === 200 ? await res.text() : "" };
}

// ---------------------------------------------------------------------------
// A–C — confirmation metrics, rate, time
// ---------------------------------------------------------------------------

describe("confirmation analytics", () => {
  it("A/B — entered, confirmed (status OR confirmedAt), pending, cancelled-before-confirmation, rate", async () => {
    await onlineWorld();
    const c = await getConfirmationAnalytics(MARCH, NO_FILTER);
    expect(c.entered).toBe(6); // O1–O6; O7 was placed in February
    expect(c.confirmed).toBe(4); // O1 LIVREE, O2 ECHEC, O3 RETOUR, O6 CONFIRMEE
    expect(c.pending).toBe(1); // O4
    expect(c.cancelledBeforeConfirmation).toBe(1); // O5
    expect(c.confirmationRate).toBe(66.7);
    expect(c.attempts).toBe(6); // the February attempt on O7 is excluded
    expect(Object.fromEntries(c.outcomes.map((o) => [o.outcome, o.count]))).toEqual({ CONFIRME: 3, PAS_DE_REPONSE: 1, OCCUPE: 1, ANNULE: 1 });
  });

  it("C — confirmation time: placedAt → confirmedAt over orders confirmed in the period (mean, median, sample)", async () => {
    await onlineWorld();
    const c = await getConfirmationAnalytics(MARCH, NO_FILTER);
    // O1 2h, O2 4h, O3 6h, O6 4h — O7 confirmed in February
    expect(c.confirmationTime).toEqual({ avgHours: 4, medianHours: 4, sample: 4 });
    expect(c.confirmedWithoutConfirmer).toBe(1); // O6, no CONFIRME attempt on record
  });

  it("D — the confirmer is the user who recorded the attempt, never the creator nor the commission agent", async () => {
    const w = await onlineWorld();
    const c = await getConfirmationAnalytics(MARCH, NO_FILTER);
    const byId = Object.fromEntries(c.byConfirmer.map((r) => [r.userId, r]));
    expect(Object.keys(byId).sort()).toEqual([w.confirmerA.id, w.confirmerB.id].sort());
    expect(byId[w.confirmerA.id]).toMatchObject({ attempts: 3, confirmations: 1, cancellations: 0, avgConfirmationHours: 2, sample: 1 });
    expect(byId[w.confirmerB.id]).toMatchObject({ attempts: 3, confirmations: 2, cancellations: 1, avgConfirmationHours: 5, sample: 2 });
    expect(byId[w.creator.id]).toBeUndefined();
    expect(byId[w.agentUserX.id]).toBeUndefined();

    // the confirmer filter narrows attempts / table / time, not the cohort
    const onlyB = await getConfirmationAnalytics(MARCH, { confirmerId: w.confirmerB.id });
    expect(onlyB.byConfirmer.map((r) => r.userId)).toEqual([w.confirmerB.id]);
    expect(onlyB.attempts).toBe(3);
    expect(onlyB.confirmationTime).toEqual({ avgHours: 5, medianHours: 5, sample: 2 });
    expect(onlyB.entered).toBe(6);
  });

  it("D (end to end) — real actions: creator, attempt-only user, confirmer and pre-assigned agent stay distinct", async () => {
    const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt principal", isDefault: true } });
    const product = await prisma.product.create({ data: { name: "Article", sku: "E2E-1", price: 150, cost: 60, status: "ACTIF" } });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 20 } });
    const customer = await prisma.customer.create({ data: { fullName: "Client", phone: "0600000001" } });
    const owner = await createTestUser({ role: "OWNER" });
    const agentUser = await createTestUser({ role: "CONFIRMATION" });
    const agent = await prisma.commissionAgent.create({ data: { userId: agentUser.id, ratePerOrder: 20 } });
    await as(owner);
    const created = await createOrderAction({
      customerId: customer.id,
      paymentMethod: "PAIEMENT_LIVRAISON",
      shippingCost: 0,
      discountTotal: 0,
      currency: "MAD",
      notes: "",
      internalNotes: "",
      shippingAddressLine1: "",
      shippingAddressLine2: "",
      shippingCity: "",
      shippingRegion: "",
      shippingCountry: "",
      shippingPhone: "",
      items: [{ productId: product.id, quantity: 1, unitPrice: 150, discount: 0 }],
    });
    if (!created.ok) throw new Error("seed");
    const orderId = created.data.id;
    await prisma.order.update({ where: { id: orderId }, data: { confirmationAgentId: agent.id } });

    const caller = await createTestUser({ role: "CONFIRMATION" });
    await as(caller);
    expect((await recordConfirmationAttemptAction(fd({ id: orderId, outcome: "PAS_DE_REPONSE" }))).ok).toBe(true);
    const confirmer = await createTestUser({ role: "CONFIRMATION" });
    await as(confirmer);
    expect((await recordConfirmationAttemptAction(fd({ id: orderId, outcome: "CONFIRME" }))).ok).toBe(true);

    await as(owner);
    for (const status of ["EN_PREPARATION", "EXPEDIEE", "LIVREE"]) expect((await updateOrderStatusAction(fd({ id: orderId, status }))).ok).toBe(true);

    const today = resolveAnalyticsPeriod({ period: "today" });
    const c = await getConfirmationAnalytics(today, NO_FILTER);
    const rows = Object.fromEntries(c.byConfirmer.map((r) => [r.userId, r]));
    expect(rows[confirmer.id]).toMatchObject({ attempts: 1, confirmations: 1 });
    expect(rows[caller.id]).toMatchObject({ attempts: 1, confirmations: 0 });
    expect(rows[owner.id]).toBeUndefined(); // the creator
    expect(rows[agentUser.id]).toBeUndefined(); // the commission agent

    // I — commission earned at LIVREE, for the attributed agent, at the snapshot rate
    let k = await getCommissionAnalytics(today, NO_FILTER);
    expect(k).toMatchObject({ earned: 20, earnedCount: 1, reversed: 0, net: 20 });
    expect(k.byAgent.map((r) => r.agentId)).toEqual([agent.id]);

    // J — leaving LIVREE reverses it; the ledger is read, never recomputed
    await prisma.commissionAgent.update({ where: { id: agent.id }, data: { ratePerOrder: 99 } });
    expect((await updateOrderStatusAction(fd({ id: orderId, status: "RETOUR" }))).ok).toBe(true);
    k = await getCommissionAnalytics(today, NO_FILTER);
    expect(k).toMatchObject({ earned: 20, reversed: 20, reversedCount: 1, net: 0 });

    // E/G — the shipped order is now « returned » in delivery analytics
    const d = await getDeliveryAnalytics(today, NO_FILTER);
    expect(d.overall).toMatchObject({ shipped: 1, delivered: 0, returned: 1, returnRate: 100 });
  });
});

// ---------------------------------------------------------------------------
// E–G — delivery, failures, returns
// ---------------------------------------------------------------------------

describe("delivery analytics", () => {
  it("E/F/G — population = shipped in the period (shippedAt), outcome = current status, rates over shipped", async () => {
    await onlineWorld();
    const d = await getDeliveryAnalytics(MARCH, NO_FILTER);
    // O1, O2, O3 and O7 (placed in February but SHIPPED in March)
    expect(d.overall).toMatchObject({ shipped: 4, delivered: 2, failed: 1, returned: 1, inProgress: 0, deliveryRate: 50, failureRate: 25, returnRate: 25 });
    expect(d.shippedToDelivered).toEqual({ avgHours: 36, medianHours: 36, sample: 2 }); // O1 48h, O7 24h
    expect(d.confirmedToShipped.sample).toBe(4);
    expect(d.confirmedToDelivered.sample).toBe(2);
  });

  it("E — carrier = latest real shipment; an API creation failure that never reached a carrier is ignored; provider filter narrows", async () => {
    const w = await onlineWorld();
    const d = await getDeliveryAnalytics(MARCH, NO_FILTER);
    const byName = Object.fromEntries(d.byProvider.map((r) => [r.label, r]));
    expect(Object.keys(byName).sort()).toEqual(["Amana", "Ozon"]);
    expect(byName.Amana).toMatchObject({ shipped: 2, delivered: 1, returned: 1 });
    expect(byName.Ozon).toMatchObject({ shipped: 2, delivered: 1, failed: 1 });
    const onlyAmana = await getDeliveryAnalytics(MARCH, { providerId: w.amana.id });
    expect(onlyAmana.overall.shipped).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// H — revenue; T — date ranges; U — empty data
// ---------------------------------------------------------------------------

describe("revenue analytics", () => {
  it("H — placed vs delivered revenue are distinct; exclusions; AOV; units; completed refunds only", async () => {
    await onlineWorld();
    const o = await getOnlineOverview(MARCH.range, NO_FILTER);
    expect(o).toMatchObject({
      orders: 6,
      confirmed: 4,
      shipped: 3,
      delivered: 1,
      deliveryRate: 33.3,
      cancelled: 1,
      failed: 1,
      returned: 1,
      placedRevenue: 480, // O1 300 + O4 100 + O6 80
      revenueOrders: 3,
      averageOrderValue: 160,
      unitsSold: 4,
      deliveredRevenue: 300,
      returnedValue: 150,
      refundedAmount: 150,
    });
    const series = await getOnlineRevenueSeries(MARCH, NO_FILTER);
    expect(series).toHaveLength(31);
    expect(series.reduce((n, p) => n + p.orders, 0)).toBe(6);
    expect(series.reduce((n, p) => n + p.revenue, 0)).toBe(480);
  });

  it("T — the date range selects by the metric's own date field", async () => {
    await onlineWorld();
    const feb = await getOnlineOverview(FEBRUARY.range, NO_FILTER);
    expect(feb).toMatchObject({ orders: 1, placedRevenue: 500, delivered: 1 }); // O7 by placedAt
    expect((await getDeliveryAnalytics(FEBRUARY, NO_FILTER)).overall.shipped).toBe(0); // O7 shipped in March
    expect((await getCommissionAnalytics(FEBRUARY, NO_FILTER)).earned).toBe(10); // the Feb-28 entry
    expect(resolveAnalyticsPeriod({ from: "2026-03-31", to: "2026-03-01" }).key).toBe("30d"); // inverted range → default
    expect(resolveAnalyticsPeriod({ period: "last-month" }, new Date(2026, 3, 15)).range.from).toEqual(new Date(2026, 2, 1));
  });

  it("U — empty data: zeros, null rates and durations, no fabricated values", async () => {
    const o = await getOnlineOverview(MARCH.range, NO_FILTER);
    expect(o).toMatchObject({ orders: 0, confirmationRate: null, deliveryRate: null, averageOrderValue: null, placedRevenue: 0 });
    const c = await getConfirmationAnalytics(MARCH, NO_FILTER);
    expect(c.confirmationTime).toEqual({ avgHours: null, medianHours: null, sample: 0 });
    expect(c.byConfirmer).toEqual([]);
    const d = await getDeliveryAnalytics(MARCH, NO_FILTER);
    expect(d.overall.deliveryRate).toBeNull();
    expect((await getCommissionAnalytics(MARCH, NO_FILTER)).net).toBe(0);
    expect((await getOnlineProductPerformance(MARCH.range, NO_FILTER, { withFinance: true })).rows).toEqual([]);
    expect(meaningfulDelta(10, 5, { current: 3, previous: 2 })).toBeNull(); // too few events to compare
    expect(meaningfulDelta(40, 20, { current: 40, previous: 20 })).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// I/J — commission ledger
// ---------------------------------------------------------------------------

describe("commission analytics", () => {
  it("I/J — earned, reversed, net from the ledger's own amounts, by agent (inactive kept), by entry date", async () => {
    const w = await onlineWorld();
    const k = await getCommissionAnalytics(MARCH, NO_FILTER);
    expect(k).toMatchObject({ earned: 35, earnedCount: 3, reversed: 10, reversedCount: 1, net: 25 });
    const byAgent = Object.fromEntries(k.byAgent.map((r) => [r.agentId, r]));
    expect(byAgent[w.agentX.id]).toMatchObject({ earned: 20, reversed: 10, net: 10, active: true });
    expect(byAgent[w.agentY.id]).toMatchObject({ earned: 15, reversed: 0, net: 15, active: false });
    const onlyX = await getCommissionAnalytics(MARCH, { agentId: w.agentX.id });
    expect(onlyX.net).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// K — products; L — sources; O/P — finance visibility
// ---------------------------------------------------------------------------

describe("product performance", () => {
  it("K/O — per product+variation and per category; returns by return date; cost only with finance", async () => {
    const w = await onlineWorld();
    const p = await getOnlineProductPerformance(MARCH.range, NO_FILTER, { withFinance: true });
    const byKey = Object.fromEntries(p.rows.map((r) => [r.variationId ?? "base", r]));
    expect(byKey[w.variation.id]).toMatchObject({ units: 2, orders: 1, revenue: 300, returnedUnits: 0, variant: expect.stringContaining("42"), cogs: 80, grossProfit: 220 });
    expect(byKey.base).toMatchObject({ units: 2, orders: 2, revenue: 180, returnedUnits: 1, cogs: 80, grossProfit: 100 });
    expect(p.categories).toEqual([expect.objectContaining({ name: "Chaussures", units: 4, orders: 3, revenue: 480, returnedUnits: 1 })]);
    expect((await getOnlineProductPerformance(MARCH.range, { categoryId: "nope" }, { withFinance: false })).rows).toEqual([]);
  });

  it("P — without finance.view the rows carry no cost / profit field at all", async () => {
    await onlineWorld();
    const p = await getOnlineProductPerformance(MARCH.range, NO_FILTER, { withFinance: false });
    for (const r of [...p.rows, ...p.categories]) {
      expect(r).not.toHaveProperty("cogs");
      expect(r).not.toHaveProperty("grossProfit");
    }
  });
});

describe("sources", () => {
  it("L — funnel per origin (displayOrderChannel grouping); the source filter narrows every figure", async () => {
    await onlineWorld();
    const f = Object.fromEntries((await getOnlineSourceFunnel(MARCH.range, NO_FILTER)).map((r) => [r.key, r]));
    expect(f.WOOCOMMERCE).toMatchObject({ orders: 2, confirmed: 2, shipped: 1, delivered: 1, revenue: 380 });
    expect(f["INTERNE:WHATSAPP"]).toMatchObject({ orders: 1, failed: 1 });
    expect(f["INTERNE:INSTAGRAM"]).toMatchObject({ orders: 1, returned: 1 });
    expect(f.SHOPIFY).toMatchObject({ orders: 1, confirmed: 0 });
    expect(f["INTERNE:TELEPHONE"]).toMatchObject({ orders: 1, cancelled: 1 });
    const woo = await getOnlineOverview(MARCH.range, parseAnalyticsFilters({ source: "WOOCOMMERCE" }));
    expect(woo).toMatchObject({ orders: 2, placedRevenue: 380 });
    expect(parseAnalyticsFilters({ source: "'; DROP", emplacement: "../x" })).toMatchObject({ source: undefined, warehouseId: undefined });
  });
});

// ---------------------------------------------------------------------------
// M/N/V/W/X/R — store scope, authorization
// ---------------------------------------------------------------------------

describe("store analytics and authorization", () => {
  it("M/V — locations filter; a multi-location manager sees both stores, a single-location one only theirs", async () => {
    const w = await storeWorld();
    const both = await as(await storeManager(w, [w.whA, w.whB]));
    expect((await getStoreOverview(both, SEVEN_DAYS, NO_FILTER)).report).toMatchObject({ salesCount: 2, grossSales: 600 });
    expect((await getStoreOverview(both, SEVEN_DAYS, { warehouseId: w.whB.id })).report).toMatchObject({ salesCount: 1, grossSales: 400 });
    const onlyA = await as(await storeManager(w, [w.whA]));
    const a = await getStoreOverview(onlyA, SEVEN_DAYS, NO_FILTER);
    expect(a.report).toMatchObject({ salesCount: 1, grossSales: 200 });
    expect(a.report.byLocation.map((l) => l.name)).toEqual(["Magasin A"]);
  });

  it("N — an unauthorized location / store in the URL cannot widen the scope", async () => {
    const w = await storeWorld();
    const me = await as(await storeManager(w, [w.whA]));
    const filters = parseAnalyticsFilters({ emplacement: w.whB.id });
    expect((await getStoreOverview(me, SEVEN_DAYS, filters)).report.salesCount).toBe(0);
    expect((await getStoreProductPerformance(me, SEVEN_DAYS.range, filters, { withFinance: false })).rows).toEqual([]);
    const otherStore = await prisma.salesChannel.create({ data: { name: "Autre", kind: "OFFLINE" } });
    expect((await getStoreOverview(me, SEVEN_DAYS, { storeChannelId: otherStore.id })).report.salesCount).toBe(0);
  });

  it("W — Store Manager: store analytics only, no Online, no commissions, no finance; no cost in store products", async () => {
    const w = await storeWorld();
    const me = await as(await storeManager(w, [w.whA]));
    expect(analyticsAccess(me)).toEqual({ online: false, store: true, commissions: false, finance: false });
    const p = await getStoreProductPerformance(me, SEVEN_DAYS.range, NO_FILTER, { withFinance: analyticsAccess(me).finance });
    expect(p.rows).toEqual([expect.objectContaining({ units: 1, orders: 1, revenue: 200 })]);
    expect(p.rows[0]).not.toHaveProperty("cogs");
    for (const section of ["confirmation", "delivery", "commissions"] as const) {
      await expect(analyticsContext({}, section)).rejects.toBeInstanceOf(RedirectSignal);
    }
    await expect(analyticsContext({}, "overview")).resolves.toBeTruthy();
    const { default: ConfirmationPage } = await import("@/app/(protected)/analyses/confirmation/page");
    await expect(ConfirmationPage({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(RedirectSignal);
  });

  it("X — Store Seller: no analytics.view, every section and export refused", async () => {
    const w = await storeWorld();
    const seller = await createTestUser({ role: "STORE_SELLER", channels: "none" });
    await grantChannelAccess(seller.id, w.shared.id);
    await grantLocationAccess(seller.id, w.whA.id);
    const me = await as(seller);
    expect(analyticsAccess(me)).toEqual({ online: false, store: false, commissions: false, finance: false });
    await expect(analyticsContext({}, "overview")).rejects.toBeInstanceOf(RedirectSignal);
    await expect(csv("produits")).rejects.toBeInstanceOf(RedirectSignal);
  });

  it("R — Online and Offline never mix: a POS sale is not an Online order, an order is not a POS sale", async () => {
    await onlineWorld();
    const w = await storeWorld();
    const admin = await as(w.admin);
    const online = await getOnlineOverview(SEVEN_DAYS.range, NO_FILTER);
    expect(online.orders).toBe(0); // the fixture orders are in March; the two sales are today
    const store = await getStoreOverview(admin, SEVEN_DAYS, NO_FILTER);
    expect(store.report.salesCount).toBe(2);
    const marchStore = await getStoreOverview(admin, MARCH, NO_FILTER);
    expect(marchStore.report.salesCount).toBe(0); // the March ORDERS never appear as store sales
    expect((await getOnlineProductPerformance(SEVEN_DAYS.range, NO_FILTER, { withFinance: true })).rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Q — CSV authorization; S — tenant isolation
// ---------------------------------------------------------------------------

describe("CSV exports and tenant isolation", () => {
  const MARCH_QS = "from=2026-03-01&to=2026-03-31";

  it("Q — CSV follows the screen: cost columns only with finance.view, 403 on sections the viewer may not open", async () => {
    await onlineWorld();
    const admin = await createTestUser({ role: "ADMIN" });
    await as(admin);
    const withFinance = await csv("produits", MARCH_QS);
    expect(withFinance.status).toBe(200);
    expect(withFinance.body).toContain("Bénéfice brut");

    const manager = await createTestUser({ role: "MANAGER" });
    await prisma.userPermissionOverride.create({ data: { userId: manager.id, permission: "finance.view", effect: "DENY" } });
    await as(manager);
    const noFinance = await csv("produits", MARCH_QS);
    expect(noFinance.status).toBe(200);
    expect(noFinance.body).toContain("Basket");
    expect(noFinance.body).not.toMatch(/Coût|Bénéfice/);
    expect((await csv("confirmation", MARCH_QS)).body).toContain("Par confirmateur");
    expect((await csv("inconnu", MARCH_QS)).status).toBe(404);

    const w = await storeWorld();
    await as(await storeManager(w, [w.whA]));
    for (const type of ["revenus", "confirmation", "livraison", "commissions"]) expect((await csv(type)).status).toBe(403);
    const storeCsv = await csv("produits");
    expect(storeCsv.status).toBe(200);
    expect(storeCsv.body).not.toMatch(/Coût|Bénéfice|En ligne/);
    const sources = await csv("canaux", `emplacement=${w.whB.id}`);
    expect(sources.body).not.toContain("Magasin B");
  });

  it("S — another tenant's viewer reads none of this tenant's analytics", async () => {
    await onlineWorld();
    await prismaBase.tenant.create({ data: { id: "tenant-z-0051", name: "Z", slug: "tenant-z-0051" } });
    const zCustomer = await prismaBase.customer.create({ data: { tenantId: "tenant-z-0051", fullName: "Z" } });
    await prismaBase.order.create({ data: { tenantId: "tenant-z-0051", customerId: zCustomer.id, status: "LIVREE", subtotal: 999, total: 999, placedAt: at(3, 3), shippedAt: at(3, 3), deliveredAt: at(3, 4) } });
    const z = await createTestUser({ role: "ADMIN", tenantId: "tenant-z-0051" });
    await as(z);
    // Pinned with the explicit tenant directive (the same app-level filter +
    // RLS GUC as a session): under vitest, a CONCURRENT dynamic
    // `import("next/headers")` can resolve to the real, unmocked module, so
    // the ambient-session resolver falls back to the bootstrap tenant inside
    // a Promise.all — a harness artifact, reported in docs/adr/0051.
    await runWithTenant("tenant-z-0051", "test:analytics-tenant-z", async () => {
      expect(await getOnlineOverview(MARCH.range, NO_FILTER)).toMatchObject({ orders: 1, placedRevenue: 999 });
      expect((await getConfirmationAnalytics(MARCH, NO_FILTER)).attempts).toBe(0);
      expect((await getDeliveryAnalytics(MARCH, NO_FILTER)).overall.shipped).toBe(1);
      expect((await getCommissionAnalytics(MARCH, NO_FILTER)).earnedCount).toBe(0);
      expect((await getOnlineProductPerformance(MARCH.range, NO_FILTER, { withFinance: true })).rows).toEqual([]);
      expect((await getOnlineSourceFunnel(MARCH.range, NO_FILTER)).map((r) => r.orders)).toEqual([1]);
    });
    // and back in tenant « default », its own figures are untouched by Z's order
    await runWithTenant("default", "test:analytics-tenant-default", async () => {
      expect((await getOnlineOverview(MARCH.range, NO_FILTER)).placedRevenue).toBe(480);
    });
  });
});
