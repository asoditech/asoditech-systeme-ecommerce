import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { createOrderAction, updateOrderStatusAction, cancelOrderAction, reopenOrderAction } from "@/actions/orders";
import { recordConfirmationAttemptAction } from "@/actions/order-confirmation";
import { assignOrderConfirmationAgentAction, updateCommissionAgentAction } from "@/actions/commissions";
import { createSaleAction } from "@/actions/sales";
import { reconcileOrderCommission, getAgentCommissionTotals } from "@/lib/commissions";
import { importOrder as importWooOrder } from "@/lib/integrations/woocommerce/sync";
import { importOrder as importShopifyOrder } from "@/lib/integrations/shopify/sync";
import type { CreateOrderInput } from "@/lib/validation/order";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser, createTestUser, grantChannelAccess, grantLocationAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Phase 6D — Online confirmation + commission hardening (docs/adr/0049).
 * Builds on ADR 0045 (canonical confirmation) and 0046 (« client déjà confirmé »).
 */

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
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
const QTY = 2;

async function seedCatalog() {
  const warehouse = await prisma.warehouse.create({ data: { id: "default-warehouse", name: "Entrepôt principal", isDefault: true } });
  const product = await prisma.product.create({ data: { name: "Coffret", sku: "SKU-6D", price: 100, cost: 40, status: "ACTIF" } });
  const item = await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 50 } });
  const customer = await prisma.customer.create({ data: { fullName: "Nadia Berrada", phone: "0600000000" } });
  return { warehouse, product, itemId: item.id, customerId: customer.id };
}
const orderInput = (seed: { product: { id: string }; customerId: string }, extra: Partial<CreateOrderInput> = {}): CreateOrderInput => ({
  customerId: seed.customerId,
  paymentMethod: "PAIEMENT_LIVRAISON",
  channel: "WHATSAPP",
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
  items: [{ productId: seed.product.id, quantity: QTY, unitPrice: 100, discount: 0 }],
  ...extra,
});

/** A NOUVELLE manual order created by an OWNER (then logged out). */
async function nouvelleOrder(seed: Awaited<ReturnType<typeof seedCatalog>>) {
  await loginAsTestUser({ role: "OWNER" });
  const r = await createOrderAction(orderInput(seed));
  if (!r.ok) throw new Error(r.error);
  mockCookieStore.clear();
  return r.data.id;
}
/** A CONFIRMATION-role user, logged in, optionally a commission agent. */
async function loginConfirmer(seed: { warehouse: { id: string } }, agent: "active" | "inactive" | "none") {
  const user = await loginAsTestUser({ role: "CONFIRMATION" });
  await grantLocationAccess(user.id, seed.warehouse.id);
  const a = agent === "none" ? null : await prisma.commissionAgent.create({ data: { userId: user.id, ratePerOrder: 15, isActive: agent === "active" } });
  return { user, agent: a };
}
const orderOf = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });
const confirmAttempts = (orderId: string) => prisma.orderConfirmationAttempt.findMany({ where: { orderId, outcome: "CONFIRME" }, orderBy: { createdAt: "asc" } });
const deliver = async (id: string) => {
  await prisma.order.update({ where: { id }, data: { status: "LIVREE", deliveredAt: new Date() } });
  return reconcileOrderCommission(id, null);
};

// ---------------------------------------------------------------------------
// Inactive agents never receive a NEW attribution
// ---------------------------------------------------------------------------

describe("inactive CommissionAgent — no new attribution (A, B, R)", () => {
  it("A. manager assigns an ACTIVE agent → attributed", async () => {
    const seed = await seedCatalog();
    const id = await nouvelleOrder(seed);
    const u = await createTestUser({ role: "CONFIRMATION" });
    const agent = await prisma.commissionAgent.create({ data: { userId: u.id, ratePerOrder: 20 } });
    await loginAsTestUser({ role: "MANAGER" });
    expect((await assignOrderConfirmationAgentAction(fd({ orderId: id, agentId: agent.id }))).ok).toBe(true);
    expect((await orderOf(id)).confirmationAgentId).toBe(agent.id);
  });

  it("B. manager assigns an INACTIVE agent → refused, previous attribution kept", async () => {
    const seed = await seedCatalog();
    const id = await nouvelleOrder(seed);
    const [u1, u2] = [await createTestUser({ role: "CONFIRMATION" }), await createTestUser({ role: "CONFIRMATION" })];
    const active = await prisma.commissionAgent.create({ data: { userId: u1.id, ratePerOrder: 20 } });
    const inactive = await prisma.commissionAgent.create({ data: { userId: u2.id, ratePerOrder: 20, isActive: false } });
    await loginAsTestUser({ role: "MANAGER" });
    expect((await assignOrderConfirmationAgentAction(fd({ orderId: id, agentId: active.id }))).ok).toBe(true);
    const r = await assignOrderConfirmationAgentAction(fd({ orderId: id, agentId: inactive.id }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/désactivé/);
    expect((await orderOf(id)).confirmationAgentId).toBe(active.id);
  });

  it("R. a crafted INACTIVE agent id at manual order creation is refused (manager) — and any agent id is refused without commissions.manage", async () => {
    const seed = await seedCatalog();
    const u = await createTestUser({ role: "CONFIRMATION" });
    const inactive = await prisma.commissionAgent.create({ data: { userId: u.id, ratePerOrder: 20, isActive: false } });
    const manager = await loginAsTestUser({ role: "MANAGER" });
    await grantLocationAccess(manager.id, seed.warehouse.id);
    for (const customerAlreadyConfirmed of [false, true]) {
      const r = await createOrderAction(orderInput(seed, { confirmationAgentId: inactive.id, customerAlreadyConfirmed }));
      expect(r.ok, String(customerAlreadyConfirmed)).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/désactivé/);
    }
    mockCookieStore.clear();
    await loginConfirmer(seed, "active");
    const r = await createOrderAction(orderInput(seed, { confirmationAgentId: inactive.id }));
    expect(r.ok).toBe(false);
    expect(await prisma.order.count()).toBe(0);
  });

  it("C. history of a since-deactivated agent is untouched: entries, totals, order attribution; re-saving that agent is a no-op", async () => {
    const seed = await seedCatalog();
    const id = await nouvelleOrder(seed);
    const { agent } = await loginConfirmer(seed, "active");
    expect((await recordConfirmationAttemptAction(fd({ id, outcome: "CONFIRME" }))).ok).toBe(true);
    expect((await deliver(id)).outcome).toBe("earned");

    mockCookieStore.clear();
    await loginAsTestUser({ role: "ADMIN" });
    expect((await updateCommissionAgentAction(fd({ agentId: agent!.id, ratePerOrder: "99", isActive: "false" }))).ok).toBe(true);
    const entries = await prisma.commissionEntry.findMany({ where: { orderId: id } });
    expect(entries.map((e) => [e.type, Number(e.amount), e.agentId])).toEqual([["EARNED", 15, agent!.id]]);
    expect((await getAgentCommissionTotals(agent!.id)).lifetimeNet).toBe(15);
    expect((await orderOf(id)).confirmationAgentId).toBe(agent!.id);
    // re-submitting the order's CURRENT (now inactive) agent is not a new attribution
    expect((await assignOrderConfirmationAgentAction(fd({ orderId: id, agentId: agent!.id }))).ok).toBe(true);
    expect(await prisma.commissionEntry.count({ where: { orderId: id } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Confirmation entry points
// ---------------------------------------------------------------------------

describe("confirmation entry points (D-G)", () => {
  it("D/E. « client déjà confirmé »: creator's ACTIVE agent attributed; INACTIVE agent not — creator recorded as confirmer either way", async () => {
    const seed = await seedCatalog();
    for (const kind of ["active", "inactive"] as const) {
      mockCookieStore.clear();
      const { user, agent } = await loginConfirmer(seed, kind);
      const r = await createOrderAction(orderInput(seed, { customerAlreadyConfirmed: true }));
      if (!r.ok) throw new Error(r.error);
      const order = await orderOf(r.data.id);
      expect(order.status).toBe("CONFIRMEE");
      expect(order.confirmationAgentId, kind).toBe(kind === "active" ? agent!.id : null);
      expect((await confirmAttempts(r.data.id)).map((a) => a.agentUserId)).toEqual([user.id]);
    }
  });

  it("F/G. normal confirmation: active agent attributed; a non-agent confirms without attribution", async () => {
    const seed = await seedCatalog();
    const a = await nouvelleOrder(seed);
    const b = await nouvelleOrder(seed);
    const { agent } = await loginConfirmer(seed, "active");
    expect((await recordConfirmationAttemptAction(fd({ id: a, outcome: "CONFIRME" }))).ok).toBe(true);
    expect((await orderOf(a)).confirmationAgentId).toBe(agent!.id);
    mockCookieStore.clear();
    const { user } = await loginConfirmer(seed, "none");
    expect((await updateOrderStatusAction(fd({ id: b, status: "CONFIRMEE" }))).ok).toBe(true);
    expect((await orderOf(b)).confirmationAgentId).toBeNull();
    expect((await confirmAttempts(b)).map((x) => x.agentUserId)).toEqual([user.id]);
  });
});

// ---------------------------------------------------------------------------
// Reopen semantics — every ANNULEE → NOUVELLE path
// ---------------------------------------------------------------------------

describe("reopen clears the CURRENT confirmation state on every path (H-J, M, N)", () => {
  async function confirmedThenCancelled(seed: Awaited<ReturnType<typeof seedCatalog>>) {
    const id = await nouvelleOrder(seed);
    const { user, agent } = await loginConfirmer(seed, "active");
    expect((await recordConfirmationAttemptAction(fd({ id, outcome: "CONFIRME" }))).ok).toBe(true);
    mockCookieStore.clear();
    await loginAsTestUser({ role: "OWNER" }); // orders.cancel
    expect((await cancelOrderAction(fd({ id, reason: "client injoignable" }))).ok).toBe(true);
    mockCookieStore.clear();
    return { id, firstUser: user, firstAgent: agent! };
  }

  it("H-J. the STATUS MENU (ANNULEE → « Nouvelle ») now resets confirmedAt + attribution like « Rétablir », history kept", async () => {
    const seed = await seedCatalog();
    const { id, firstUser, firstAgent } = await confirmedThenCancelled(seed);
    expect((await orderOf(id)).confirmationAgentId).toBe(firstAgent.id);
    const auditBefore = await prisma.auditEvent.count({ where: { entityId: id } });
    await loginAsTestUser({ role: "MANAGER" });
    expect((await updateOrderStatusAction(fd({ id, status: "NOUVELLE" }))).ok).toBe(true);
    const order = await orderOf(id);
    expect(order).toMatchObject({ status: "NOUVELLE", confirmedAt: null, confirmationAgentId: null, cancelledAt: null });
    expect((await confirmAttempts(id)).map((a) => a.agentUserId)).toEqual([firstUser.id]);
    expect(await prisma.auditEvent.count({ where: { entityId: id } })).toBeGreaterThan(auditBefore);
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: id, action: "order.status_changed", metadata: { path: ["reason"], equals: "reopen" } } });
    expect(ev.previousValue).toMatchObject({ status: "ANNULEE", confirmationAgentId: firstAgent.id });
  });

  it("the status menu cannot reopen a SHIPPED order (same rule as « Rétablir »)", async () => {
    const seed = await seedCatalog();
    const { id } = await confirmedThenCancelled(seed);
    await prisma.order.update({ where: { id }, data: { shippedAt: new Date() } });
    await loginAsTestUser({ role: "MANAGER" });
    const r = await updateOrderStatusAction(fd({ id, status: "NOUVELLE" }));
    expect(r.ok).toBe(false);
    expect((await orderOf(id)).status).toBe("ANNULEE");
  });

  it("M/N. reconfirmation after « Rétablir »: a NEW attempt, a new confirmedAt, a NEW eligible agent", async () => {
    const seed = await seedCatalog();
    const { id, firstUser } = await confirmedThenCancelled(seed);
    await loginAsTestUser({ role: "OWNER" });
    expect((await reopenOrderAction(fd({ id }))).ok).toBe(true);
    mockCookieStore.clear();
    const { user: second, agent: secondAgent } = await loginConfirmer(seed, "active");
    expect((await recordConfirmationAttemptAction(fd({ id, outcome: "CONFIRME" }))).ok).toBe(true);
    const order = await orderOf(id);
    expect(order.confirmationAgentId).toBe(secondAgent!.id);
    expect(order.confirmedAt).toBeInstanceOf(Date);
    expect((await confirmAttempts(id)).map((a) => a.agentUserId)).toEqual([firstUser.id, second.id]);
  });
});

// ---------------------------------------------------------------------------
// External sync — stale confirmation state (K, L)
// ---------------------------------------------------------------------------

function wcOrder(status: string) {
  return {
    id: 9600, number: "9600", status, currency: "MAD", date_created: "2026-09-20T10:00:00", date_paid: null, customer_id: 0,
    total: 200, total_tax: 0, shipping_total: 0, discount_total: 0, payment_method: "cod", payment_method_title: null, customer_note: null,
    billing: { first_name: "Woo", last_name: "Client", company: null, address_1: "x", address_2: null, city: "Rabat", state: null, postcode: null, country: "MA", email: "woo@example.com", phone: null },
    shipping: { first_name: "", last_name: "", company: null, address_1: "", address_2: null, city: "", state: null, postcode: null, country: "", email: null, phone: null },
    line_items: [{ id: 1, name: "Coffret", product_id: null, variation_id: null, sku: "SKU-6D", quantity: QTY, price: 100, subtotal: 200, total: 200, total_tax: 0 }],
    refunds: [],
  };
}
const SHOPIFY_CREATED_AT = new Date(Date.now() - 60_000).toISOString();
function shopifyOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "gid://shopify/Order/9600", name: "#9600", createdAt: SHOPIFY_CREATED_AT,
    displayFinancialStatus: "PENDING" as const, displayFulfillmentStatus: "UNFULFILLED" as const, cancelledAt: null, cancelReason: null,
    customer: null, email: "shop@example.com", phone: null, shippingAddress: null, billingAddress: null, paymentGatewayNames: [], note: null,
    currentTotalPriceSet: { amount: 200, currency: "MAD" }, subtotalPriceSet: { amount: 200, currency: "MAD" }, totalDiscountsSet: { amount: 0, currency: "MAD" },
    totalShippingPriceSet: { amount: 0, currency: "MAD" }, totalRefundedSet: { amount: 0, currency: "MAD" },
    lineItems: { nodes: [{ id: "gid://shopify/LineItem/1", title: "Coffret", sku: "SKU-6D", quantity: QTY, variant: null, product: null, originalUnitPriceSet: { amount: 100, currency: "MAD" }, discountedTotalSet: { amount: 200, currency: "MAD" }, originalTotalSet: { amount: 200, currency: "MAD" } }] },
    refunds: [],
    ...overrides,
  };
}

describe("external sync reopening an order (K, L)", () => {
  const stores = [
    {
      name: "WooCommerce",
      source: "WOOCOMMERCE" as const,
      externalId: "9600",
      sync: (state: "new" | "cancelled") => importWooOrder(wcOrder(state === "new" ? "pending" : "cancelled"), { type: "INTEGRATION" }, { forceNouvelleOnFirstImport: true }),
    },
    {
      name: "Shopify",
      source: "SHOPIFY" as const,
      externalId: "gid://shopify/Order/9600",
      sync: (state: "new" | "cancelled") =>
        importShopifyOrder(shopifyOrder(state === "new" ? {} : { cancelledAt: new Date().toISOString(), cancelReason: "CUSTOMER" }) as never, { type: "INTEGRATION" }, { forceNouvelleOnFirstImport: true }),
    },
  ];

  for (const store of stores) {
    it(`${store.name}: store cancels then reopens → stale confirmedAt/attribution cleared, history and identity kept, reconfirmation is NEW`, async () => {
      const seed = await seedCatalog();
      await loginAsTestUser({ role: "ADMIN" });
      expect((await store.sync("new")).outcome).toBe("imported");
      const imported = await prisma.order.findFirstOrThrow({ where: { source: store.source, externalId: store.externalId } });
      expect(imported.status).toBe("NOUVELLE");
      mockCookieStore.clear();

      const { user: first, agent: firstAgent } = await loginConfirmer(seed, "active");
      expect((await recordConfirmationAttemptAction(fd({ id: imported.id, outcome: "CONFIRME" }))).ok).toBe(true);
      expect(await orderOf(imported.id)).toMatchObject({ status: "CONFIRMEE", confirmationAgentId: firstAgent!.id });
      mockCookieStore.clear();

      await loginAsTestUser({ role: "ADMIN" });
      await store.sync("cancelled");
      expect((await orderOf(imported.id)).status).toBe("ANNULEE");
      const auditBefore = await prisma.auditEvent.count({ where: { entityId: imported.id } });
      await store.sync("new");
      const reopened = await orderOf(imported.id);
      expect(reopened).toMatchObject({ status: "NOUVELLE", confirmedAt: null, confirmationAgentId: null, cancelledAt: null });
      expect(reopened).toMatchObject({ placedAt: imported.placedAt, externalId: store.externalId, source: store.source, createdById: imported.createdById, orderNumber: imported.orderNumber });
      expect((await confirmAttempts(imported.id)).map((a) => a.agentUserId)).toEqual([first.id]);
      expect(await prisma.auditEvent.count({ where: { entityId: imported.id } })).toBeGreaterThanOrEqual(auditBefore);
      mockCookieStore.clear();

      const { user: second, agent: secondAgent } = await loginConfirmer(seed, "active");
      expect((await recordConfirmationAttemptAction(fd({ id: imported.id, outcome: "CONFIRME" }))).ok).toBe(true);
      expect((await orderOf(imported.id)).confirmationAgentId).toBe(secondAgent!.id);
      expect((await confirmAttempts(imported.id)).map((a) => a.agentUserId)).toEqual([first.id, second.id]);
    });

    it(`${store.name}: a SHIPPED cancelled order is never reopened by the store`, async () => {
      await seedCatalog();
      await loginAsTestUser({ role: "ADMIN" });
      await store.sync("new");
      const o = await prisma.order.findFirstOrThrow({ where: { source: store.source, externalId: store.externalId } });
      await prisma.order.update({ where: { id: o.id }, data: { status: "ANNULEE", shippedAt: new Date(), confirmedAt: new Date() } });
      const r = await store.sync("new");
      expect(r.reason ?? "").toMatch(/expédiée/);
      expect((await orderOf(o.id)).status).toBe("ANNULEE");
    });
  }
});

// ---------------------------------------------------------------------------
// Commission state machine (O-Q)
// ---------------------------------------------------------------------------

describe("commission lifecycle (O, P, Q)", () => {
  it("P. nothing at CONFIRMEE; earned once at LIVREE at the snapshot rate; O. repeated reconciliation is idempotent", async () => {
    const seed = await seedCatalog();
    const id = await nouvelleOrder(seed);
    const { agent } = await loginConfirmer(seed, "active");
    expect((await recordConfirmationAttemptAction(fd({ id, outcome: "CONFIRME" }))).ok).toBe(true);
    expect((await reconcileOrderCommission(id, null)).outcome).toBe("unchanged");
    expect(await prisma.commissionEntry.count()).toBe(0);
    expect((await deliver(id)).outcome).toBe("earned");
    // rate changes later never touch the snapshot
    await prisma.commissionAgent.update({ where: { id: agent!.id }, data: { ratePerOrder: 50 } });
    for (let i = 0; i < 3; i++) expect((await reconcileOrderCommission(id, null)).outcome).toBe("unchanged");
    const results = await Promise.all([reconcileOrderCommission(id, null), reconcileOrderCommission(id, null)]);
    expect(results.every((r) => r.outcome === "unchanged")).toBe(true);
    const entries = await prisma.commissionEntry.findMany({ where: { orderId: id } });
    expect(entries.map((e) => [e.type, Number(e.amount), Number(e.rateApplied)])).toEqual([["EARNED", 15, 15]]);
  });

  it("Q. leaving LIVREE reverses exactly once, against the agent who earned it", async () => {
    const seed = await seedCatalog();
    const id = await nouvelleOrder(seed);
    const { agent } = await loginConfirmer(seed, "active");
    expect((await recordConfirmationAttemptAction(fd({ id, outcome: "CONFIRME" }))).ok).toBe(true);
    await deliver(id);
    await prisma.order.update({ where: { id }, data: { status: "RETOUR" } });
    expect((await reconcileOrderCommission(id, null)).outcome).toBe("reversed");
    expect((await reconcileOrderCommission(id, null)).outcome).toBe("unchanged");
    const entries = await prisma.commissionEntry.findMany({ where: { orderId: id }, orderBy: { createdAt: "asc" } });
    expect(entries.map((e) => [e.type, Number(e.amount), e.agentId])).toEqual([
      ["EARNED", 15, agent!.id],
      ["REVERSED", -15, agent!.id],
    ]);
  });

  it("a reopenable order never carries a commission entry: reopen + reconfirm + deliver earns exactly once, for the current agent", async () => {
    const seed = await seedCatalog();
    const id = await nouvelleOrder(seed);
    await loginConfirmer(seed, "active");
    expect((await recordConfirmationAttemptAction(fd({ id, outcome: "CONFIRME" }))).ok).toBe(true);
    mockCookieStore.clear();
    await loginAsTestUser({ role: "OWNER" });
    expect((await cancelOrderAction(fd({ id, reason: "erreur" }))).ok).toBe(true);
    expect(await prisma.commissionEntry.count({ where: { orderId: id } })).toBe(0);
    mockCookieStore.clear();
    await loginAsTestUser({ role: "OWNER" });
    expect((await reopenOrderAction(fd({ id }))).ok).toBe(true);
    mockCookieStore.clear();
    const { agent: second } = await loginConfirmer(seed, "active");
    expect((await recordConfirmationAttemptAction(fd({ id, outcome: "CONFIRME" }))).ok).toBe(true);
    await deliver(id);
    await deliver(id);
    const entries = await prisma.commissionEntry.findMany({ where: { orderId: id } });
    expect(entries.map((e) => [e.type, e.agentId])).toEqual([["EARNED", second!.id]]);
  });
});

// ---------------------------------------------------------------------------
// Permissions, tenants, Offline (S, T)
// ---------------------------------------------------------------------------

describe("permissions, tenant isolation, Offline", () => {
  it("orders.confirm gates the queue; commissions.manage gates assignment", async () => {
    const seed = await seedCatalog();
    const id = await nouvelleOrder(seed);
    const u = await loginAsTestUser({ role: "WAREHOUSE" });
    await expect(recordConfirmationAttemptAction(fd({ id, outcome: "CONFIRME" }))).rejects.toThrow(/non autorisé/i);
    await expect(assignOrderConfirmationAgentAction(fd({ orderId: id, agentId: "x" }))).rejects.toThrow(/non autorisé/i);
    mockCookieStore.clear();
    await loginConfirmer(seed, "active"); // orders.confirm, no commissions.manage
    await expect(assignOrderConfirmationAgentAction(fd({ orderId: id, agentId: "x" }))).rejects.toThrow(/non autorisé/i);
    expect(u).toBeDefined();
    expect((await orderOf(id)).status).toBe("NOUVELLE");
  });

  it("S. tenant isolation: another tenant's agent cannot be assigned, its order cannot be touched by a sync", async () => {
    const seed = await seedCatalog();
    const id = await nouvelleOrder(seed);
    await prismaBase.tenant.create({ data: { id: "tenant-b-0049", name: "B", slug: "tenant-b-0049" } });
    const userB = await prismaBase.user.create({ data: { email: "b-0049@asoditech.test", name: "B", passwordHash: "x", role: "CONFIRMATION", tenantId: "tenant-b-0049" } });
    const agentB = await prismaBase.commissionAgent.create({ data: { userId: userB.id, ratePerOrder: 10, tenantId: "tenant-b-0049" } });
    const custB = await prismaBase.customer.create({ data: { fullName: "Client B", tenantId: "tenant-b-0049" } });
    const confirmedAt = new Date("2026-09-01T10:00:00Z");
    const orderB = await prismaBase.order.create({
      data: { tenantId: "tenant-b-0049", customerId: custB.id, source: "WOOCOMMERCE", externalId: "9600", status: "ANNULEE", confirmedAt, confirmationAgentId: agentB.id, subtotal: 1, total: 1 },
    });

    await loginAsTestUser({ role: "MANAGER" });
    const r = await assignOrderConfirmationAgentAction(fd({ orderId: id, agentId: agentB.id }));
    expect(r.ok).toBe(false);
    expect((await orderOf(id)).confirmationAgentId).toBeNull();

    // tenant A's sync of the SAME external id imports its own order — tenant B's stays as it was
    await importWooOrder(wcOrder("pending"), { type: "INTEGRATION" }, { forceNouvelleOnFirstImport: true });
    const b = await prismaBase.order.findUniqueOrThrow({ where: { id: orderB.id } });
    expect(b).toMatchObject({ status: "ANNULEE", confirmationAgentId: agentB.id });
    expect(b.confirmedAt?.getTime()).toBe(confirmedAt.getTime());
  });

  it("T. Offline POS is untouched: a store sale creates no confirmation attempt and no commission", async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    const store = await prisma.warehouse.create({ data: { name: "Boutique", type: "MAGASIN" } });
    const channel = await prisma.salesChannel.create({ data: { name: "Magasin Casa", kind: "OFFLINE" } });
    await prisma.salesChannelLocation.create({ data: { salesChannelId: channel.id, warehouseId: store.id } });
    const product = await prisma.product.create({ data: { name: "Basket", sku: "B-6D", price: 250, status: "ACTIF" } });
    await prisma.productSalesChannel.create({ data: { productId: product.id, salesChannelId: channel.id } });
    await prisma.inventoryItem.create({ data: { warehouseId: store.id, productId: product.id, quantityOnHand: 3 } });
    const seller = await loginAsTestUser({ role: "STORE_SELLER", channels: "none" });
    await grantChannelAccess(seller.id, channel.id);
    await grantLocationAccess(seller.id, store.id);
    const me = await prisma.user.findUniqueOrThrow({ where: { id: seller.id } });
    expect(me.role).toBe("STORE_SELLER");
    const r = await createSaleAction({ salesChannelId: channel.id, warehouseId: store.id, idempotencyKey: randomUUID(), lines: [{ productId: product.id, quantity: 1 }], payments: [{ method: "ESPECES", amount: 250 }] });
    expect(r.ok).toBe(true);
    expect(await prisma.orderConfirmationAttempt.count()).toBe(0);
    expect(await prisma.commissionEntry.count()).toBe(0);
    await expect(recordConfirmationAttemptAction(fd({ id: "any", outcome: "CONFIRME" }))).rejects.toThrow(/non autorisé/i);
  });
});
