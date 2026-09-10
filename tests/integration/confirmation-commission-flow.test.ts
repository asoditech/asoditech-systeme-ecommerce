import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createOrderAction, updateOrderStatusAction } from "@/actions/orders";
import { recordConfirmationAttemptAction } from "@/actions/order-confirmation";
import { getOrderConfirmationAttempts } from "@/lib/queries/order-confirmation";
import { getOrderCommission, listAgentPerformance } from "@/lib/queries/commissions";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * End-to-end regression for the Confirmation ↔ Commission integration: an
 * unsuccessful attempt by one agent must never earn credit, the *confirming*
 * agent becomes the owner, and money only ever moves at LIVREE/RETOUR via
 * the existing `reconcileOrderCommission` — never at confirmation time.
 */

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function seedNouvelleOrder(qty = 2) {
  const warehouse = await prisma.warehouse.create({
    data: { id: "default-warehouse", name: "Entrepôt principal", isDefault: true },
  });
  const product = await prisma.product.create({
    data: { name: "Article", sku: "SKU-FLOW-1", price: 150, cost: 60, status: "ACTIF" },
  });
  await prisma.inventoryItem.create({
    data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 20 },
  });
  const customer = await prisma.customer.create({ data: { fullName: "Client Flow", phone: "0600000000" } });

  await loginAsTestUser({ role: "OWNER" });
  const res = await createOrderAction({
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
    items: [{ productId: product.id, quantity: qty, unitPrice: 150, discount: 0 }],
  });
  if (!res.ok) throw new Error("order seed failed");
  return res.data.id;
}

describe("confirmation → delivery → commission (cross-module)", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("attempt-agent without credit, confirming agent becomes owner, commission only earns at LIVREE and reverses at RETOUR", async () => {
    const orderId = await seedNouvelleOrder(2);

    // Agent A attempts and fails — no CommissionAgent record, no credit.
    const agentA = await loginAsTestUser({ role: "CONFIRMATION" });
    await recordConfirmationAttemptAction(fd({ id: orderId, outcome: "PAS_DE_REPONSE", note: "ne répond pas" }));

    // Agent B confirms — registered as a CommissionAgent, becomes the owner.
    const agentB = await loginAsTestUser({ role: "CONFIRMATION" });
    const agentBRecord = await prisma.commissionAgent.create({ data: { userId: agentB.id, ratePerOrder: 20 } });
    const confirmRes = await recordConfirmationAttemptAction(fd({ id: orderId, outcome: "CONFIRME" }));
    expect(confirmRes.ok).toBe(true);

    const confirmedOrder = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(confirmedOrder.status).toBe("CONFIRMEE");
    expect(confirmedOrder.confirmationAgentId).toBe(agentBRecord.id);

    // History distinguishes the two attempt-agents; the owner is B, not A.
    const history = await getOrderConfirmationAttempts(orderId);
    expect(history).toHaveLength(2);
    const names = history.map((h) => h.agent?.name);
    expect(names).toContain(agentA.name);
    expect(names).toContain(agentB.name);

    // Confirmation ≠ earned commission — nothing in the ledger yet.
    let commission = await getOrderCommission(orderId);
    expect(commission?.hasEntries).toBe(false);
    expect(await prisma.commissionEntry.count({ where: { orderId } })).toBe(0);

    // The performance view attributes the confirmed order to B (the
    // confirming agent), never to A (who only attempted and failed).
    let performance = await listAgentPerformance();
    let bRow = performance.find((r) => r.id === agentBRecord.id)!;
    expect(bRow.confirmedTotal).toBe(1);
    expect(bRow.pipeline.delivered).toBe(0);
    expect(bRow.breakdown.earnedAmount).toBe(0);

    // Deliver — this is the only trigger that earns the commission.
    await loginAsTestUser({ role: "OWNER" });
    await updateOrderStatusAction(fd({ id: orderId, status: "EN_PREPARATION" }));
    await updateOrderStatusAction(fd({ id: orderId, status: "EXPEDIEE" }));
    await updateOrderStatusAction(fd({ id: orderId, status: "LIVREE" }));

    commission = await getOrderCommission(orderId);
    expect(commission?.hasEntries).toBe(true);
    expect(commission?.net).toBe(20);
    const earnedEntries = await prisma.commissionEntry.findMany({ where: { orderId, type: "EARNED" } });
    expect(earnedEntries).toHaveLength(1);
    expect(earnedEntries[0].agentId).toBe(agentBRecord.id);
    expect(Number(earnedEntries[0].amount)).toBe(20);

    performance = await listAgentPerformance();
    bRow = performance.find((r) => r.id === agentBRecord.id)!;
    expect(bRow.pipeline.delivered).toBe(1);
    expect(bRow.conversion).toBe(1);
    expect(bRow.breakdown.earnedAmount).toBe(20);

    // Returned after delivery — the earned entry is reversed, never re-earned.
    await updateOrderStatusAction(fd({ id: orderId, status: "RETOUR" }));

    const allEntries = await prisma.commissionEntry.findMany({ where: { orderId } });
    expect(allEntries).toHaveLength(2);
    expect(allEntries.reduce((s, e) => s + Number(e.amount), 0)).toBe(0);

    commission = await getOrderCommission(orderId);
    expect(commission?.net).toBe(0);

    // The performance view's net reflects the reversal too — no second
    // commission calculation, just a read of the same ledger.
    performance = await listAgentPerformance();
    bRow = performance.find((r) => r.id === agentBRecord.id)!;
    expect(bRow.pipeline.returned).toBe(1);
    expect(bRow.breakdown.earnedAmount).toBe(20);
    expect(bRow.breakdown.reversedAmount).toBe(-20);
    expect(bRow.breakdown.netAmount).toBe(0);
  });
});
