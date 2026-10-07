import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createOrderAction, updateOrderStatusAction } from "@/actions/orders";
import { previewOrderPurgeAction, purgeTestOrderAction } from "@/actions/order-purge";
import { userHasPermission } from "@/lib/auth/permissions";
import { getCurrentUser } from "@/lib/auth/session";
import { purgeOutcome, shouldOfferPurge } from "@/lib/orders/purge-ui";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * The order page's purge flow end to end, with the real server actions:
 * what the page decides to show, then the dialog's success / refusal handling.
 */

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function seedOrder(steps: string[] = []) {
  await prisma.warehouse.create({ data: { id: "wh", name: "Entrepôt", isDefault: true } });
  const product = await prisma.product.create({ data: { name: "Casquette", sku: "CAP-1", price: 50, status: "ACTIF" } });
  await prisma.inventoryItem.create({ data: { warehouseId: "wh", productId: product.id, quantityOnHand: 10 } });
  const customer = await prisma.customer.create({ data: { fullName: "Client Test" } });
  const created = await createOrderAction({
    customerId: customer.id,
    paymentMethod: "PAIEMENT_LIVRAISON",
    shippingCost: 0,
    discountTotal: 0,
    currency: "MAD",
    notes: "",
    internalNotes: "",
    shippingAddressLine1: "1 Rue X",
    shippingAddressLine2: "",
    shippingCity: "Rabat",
    shippingRegion: "",
    shippingCountry: "Maroc",
    shippingPhone: "",
    items: [{ productId: product.id, quantity: 2, unitPrice: 50, discount: 0 }],
  });
  if (!created.ok) throw new Error(created.error);
  for (const status of steps) {
    const r = await updateOrderStatusAction(fd({ id: created.data.id, status }));
    if (!r.ok) throw new Error(r.error);
  }
  return created.data.id;
}

/** Exactly what the order page computes. */
async function pageOffersPurge(orderId: string) {
  const user = (await getCurrentUser())!;
  const canPurge = userHasPermission(user, "orders.purge");
  const evaluation = canPurge ? await previewOrderPurgeAction(orderId) : null;
  return shouldOfferPurge(canPurge, evaluation);
}

describe("order page — when « Purger cette commande de test » appears", () => {
  it("eligible order + OWNER/ADMIN → shown", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const orderId = await seedOrder(["CONFIRMEE", "EN_PREPARATION"]);
    expect(await pageOffersPurge(orderId)).toBe(true);
  });

  it("ineligible order (shipped) → hidden", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const orderId = await seedOrder(["CONFIRMEE", "EN_PREPARATION", "EXPEDIEE"]);
    expect(await pageOffersPurge(orderId)).toBe(false);
  });

  it("no orders.purge (MANAGER) → hidden, and the actions refuse server-side", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const orderId = await seedOrder();
    mockCookieStore.clear();
    await loginAsTestUser({ role: "MANAGER" });
    expect(await pageOffersPurge(orderId)).toBe(false);
    await expect(purgeTestOrderAction({ orderId, reason: "Test" })).rejects.toThrow(/non autorisé/i);
  });
});

describe("dialog confirmation → server action → outcome", () => {
  it("successful purge → success message and redirect to /commandes; the order URL no longer resolves", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const orderId = await seedOrder(["CONFIRMEE"]);
    const outcome = purgeOutcome(await purgeTestOrderAction({ orderId, reason: "Commande de test" }));
    expect(outcome).toEqual({ kind: "success", message: "Commande CMD-000001 purgée.", redirectTo: "/commandes" });
    expect(await prisma.order.findUnique({ where: { id: orderId } })).toBeNull();
  });

  it("server-side refusal (state changed after the dialog opened) → error shown, nothing deleted", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const orderId = await seedOrder(["CONFIRMEE", "EN_PREPARATION"]);
    expect(await pageOffersPurge(orderId)).toBe(true); // dialog opened while eligible…
    await updateOrderStatusAction(fd({ id: orderId, status: "EXPEDIEE" })); // …then someone ships it
    const outcome = purgeOutcome(await purgeTestOrderAction({ orderId, reason: "Commande de test" }));
    expect(outcome).toMatchObject({ kind: "error", message: expect.stringMatching(/expédiée/) });
    expect(await prisma.order.count({ where: { id: orderId } })).toBe(1);
  });

  it("other refusals reach the dialog with their own message (carrier parcel, refund, imported order)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const orderId = await seedOrder(["CONFIRMEE"]);
    const api = await prisma.shippingProvider.create({ data: { name: "Ozon", type: "API", providerKey: "ozonexpress" } });
    await prisma.shipment.create({ data: { orderId, providerId: api.id, status: "EN_ATTENTE", externalId: "OZE-9", trackingNumber: "OZE-9" } });
    expect(purgeOutcome(await purgeTestOrderAction({ orderId, reason: "Test" }))).toMatchObject({ kind: "error", message: expect.stringMatching(/OZE-9/) });
    await prisma.shipment.deleteMany({ where: { orderId } });

    await prisma.refund.create({ data: { orderId, amount: 5 } });
    expect(purgeOutcome(await purgeTestOrderAction({ orderId, reason: "Test" }))).toMatchObject({ kind: "error", message: expect.stringMatching(/remboursement/) });
    await prisma.refund.deleteMany({ where: { orderId } });

    await prisma.order.update({ where: { id: orderId }, data: { source: "SHOPIFY", externalId: "gid://1" } });
    expect(purgeOutcome(await purgeTestOrderAction({ orderId, reason: "Test" }))).toMatchObject({ kind: "error", message: expect.stringMatching(/réimportée/) });
    expect(await prisma.order.count({ where: { id: orderId } })).toBe(1);
  });
});
