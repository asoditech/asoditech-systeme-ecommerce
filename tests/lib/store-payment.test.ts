import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { applyStorePaymentConfirmation } from "@/lib/orders/store-payment";
import { updateAutoPaymentFromStoreAction } from "@/actions/settings";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { importOrder } from "@/lib/integrations/woocommerce/sync/orders";
import type { WcOrder } from "@/lib/integrations/woocommerce/types";

/**
 * « Paiement confirmé par la boutique » (BusinessSettings.autoPaymentFromStore):
 * opt-in, EN_ATTENTE → PAYE only, store-reported only, idempotent, audited.
 */

const fd = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const setOptIn = (on: boolean) =>
  prisma.businessSettings.upsert({ where: { tenantId: "default" }, update: { autoPaymentFromStore: on }, create: { autoPaymentFromStore: on } });

async function importedOrder(paymentStatus: "EN_ATTENTE" | "PAYE" | "ECHEC" | "REMBOURSE" | "PARTIELLEMENT_PAYE" = "EN_ATTENTE") {
  const customer = await prisma.customer.create({ data: { fullName: "Client Boutique" } });
  return prisma.order.create({
    data: { customerId: customer.id, source: "WOOCOMMERCE", externalId: `wc-${Math.random()}`, subtotal: 100, total: 100, paymentStatus },
  });
}
const paymentOf = async (id: string) => (await prisma.order.findUniqueOrThrow({ where: { id } })).paymentStatus;
const auditCount = (id: string) => prisma.auditEvent.count({ where: { entityType: "Order", entityId: id, action: "order.updated" } });

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

describe("store payment confirmation", () => {
  it("OFF by default: the store reporting paid changes nothing", async () => {
    const order = await importedOrder();
    expect(await applyStorePaymentConfirmation(order.id, true, "WOOCOMMERCE")).toBe(false);
    expect(await paymentOf(order.id)).toBe("EN_ATTENTE");
    expect((await prisma.businessSettings.findFirst())?.autoPaymentFromStore ?? false).toBe(false);
  });

  it("ON: EN_ATTENTE → PAYE once, with one audit event (repeated webhook = no-op)", async () => {
    await setOptIn(true);
    const order = await importedOrder();
    expect(await applyStorePaymentConfirmation(order.id, true, "SHOPIFY")).toBe(true);
    expect(await applyStorePaymentConfirmation(order.id, true, "SHOPIFY")).toBe(false);
    expect(await paymentOf(order.id)).toBe("PAYE");
    expect(await auditCount(order.id)).toBe(1);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: order.id } });
    expect(audit).toMatchObject({ actorType: "INTEGRATION", newValue: { paymentStatus: "PAYE" } });
  });

  it("ON: never overwrites a status set by a person or a refund, never reverts on « unpaid »", async () => {
    await setOptIn(true);
    for (const status of ["ECHEC", "REMBOURSE", "PARTIELLEMENT_PAYE"] as const) {
      const order = await importedOrder(status);
      expect(await applyStorePaymentConfirmation(order.id, true, "WOOCOMMERCE")).toBe(false);
      expect(await paymentOf(order.id)).toBe(status);
    }
    const paid = await importedOrder("PAYE");
    expect(await applyStorePaymentConfirmation(paid.id, false, "WOOCOMMERCE")).toBe(false);
    expect(await paymentOf(paid.id)).toBe("PAYE");
    expect(await auditCount(paid.id)).toBe(0);
  });

  it("the switch is settings.manage-only and audited", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    await expect(updateAutoPaymentFromStoreAction(fd({ autoPaymentFromStore: "true" }))).rejects.toThrow(/non autorisé/i);

    mockCookieStore.clear();
    await loginAsTestUser({ role: "ADMIN" });
    expect((await updateAutoPaymentFromStoreAction(fd({ autoPaymentFromStore: "true" }))).ok).toBe(true);
    expect((await prisma.businessSettings.findFirstOrThrow()).autoPaymentFromStore).toBe(true);
    expect(await prisma.auditEvent.count({ where: { entityType: "BusinessSettings", action: "settings.updated" } })).toBe(1);
  });

  it("WooCommerce order.updated: date_paid appearing later → PAYE only when the opt-in is ON", async () => {
    await prisma.product.create({ data: { name: "Sac cuir", sku: "SAC", price: 180, status: "ACTIF", source: "WOOCOMMERCE", externalId: "7701" } });
    const wc = (id: number, paid: boolean) =>
      ({
        id, number: String(id), status: "processing", currency: "MAD", date_created: "2026-10-01T10:00:00", date_paid: paid ? "2026-10-02T10:00:00" : null,
        customer_id: 0, total: 180, total_tax: 0, shipping_total: 0, discount_total: 0, payment_method: "cod",
        payment_method_title: null, customer_note: null,
        billing: { first_name: "Imp", last_name: "Ort", company: null, address_1: "x", address_2: null, city: "Rabat", state: null, postcode: null, country: "MA", email: "imp@example.com", phone: null },
        shipping: { first_name: "", last_name: "", company: null, address_1: "", address_2: null, city: "", state: null, postcode: null, country: "", email: null, phone: null },
        line_items: [{ id: 1, name: "Sac cuir", product_id: 7701, variation_id: null, sku: "SAC", quantity: 1, price: 180, subtotal: 180, total: 180, total_tax: 0 }],
        refunds: [],
      }) as unknown as WcOrder;
    const status = async (id: number) => (await prisma.order.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: String(id) } })).paymentStatus;

    // OFF (default): the update leaves payment manual.
    await importOrder(wc(9401, false), { type: "INTEGRATION" });
    await importOrder(wc(9401, true), { type: "INTEGRATION" });
    expect(await status(9401)).toBe("EN_ATTENTE");

    // ON: the same update flips it once.
    await setOptIn(true);
    await importOrder(wc(9402, false), { type: "INTEGRATION" });
    expect(await status(9402)).toBe("EN_ATTENTE");
    await importOrder(wc(9402, true), { type: "INTEGRATION" });
    await importOrder(wc(9402, true), { type: "INTEGRATION" });
    expect(await status(9402)).toBe("PAYE");
    const order = await prisma.order.findFirstOrThrow({ where: { externalId: "9402" } });
    expect(await prisma.auditEvent.count({ where: { entityId: order.id, metadata: { path: ["reason"], equals: "store_reported_paid" } } })).toBe(1);
  });
});
