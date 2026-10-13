import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { createShippingProviderAction, createShipmentAction, updateShipmentStatusAction } from "@/actions/delivery";
import { createOrderAction, updateOrderStatusAction } from "@/actions/orders";
import { normalizeTrackingNumber, trackingNumberLockKey } from "@/lib/integrations/delivery/service";
import { resetDb } from "../helpers/db";
import { grantLocationAccess, loginAsTestUser } from "../helpers/auth";
import { getCurrentUser } from "@/lib/auth/session";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * A4 — a tracking number belongs to ONE live shipment per carrier (tenant
 * scoped through the carrier row). Cancelled shipments free their number;
 * another carrier may use the same string. Enforced under an advisory lock
 * in reserveShipmentSlot (manual + linked + API slot creation).
 */

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

async function seedWorld() {
  const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt principal", isDefault: true } });
  // A MANAGER operates only on the locations granted to them (docs/adr/0037).
  const me = await getCurrentUser();
  if (me) await grantLocationAccess(me.id, warehouse.id);
  const product = await prisma.product.create({ data: { name: "Coffret", sku: "SKU-TRK-1", price: 100, status: "ACTIF" } });
  await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 100 } });
  const customer = await prisma.customer.create({ data: { fullName: "Amine Tazi" } });
  const order = async () => {
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
      items: [{ productId: product.id, quantity: 1, unitPrice: 100, discount: 0 }],
    });
    if (!created.ok) throw new Error(`setup failed: ${created.error} ${JSON.stringify(created.fieldErrors ?? {})}`);
    await updateOrderStatusAction(fd({ id: created.data.id, status: "CONFIRMEE" }));
    return created.data.id;
  };
  const provider = async (name: string) => {
    const p = await createShippingProviderAction(fd({ name, type: "MANUEL" }));
    if (!p.ok) throw new Error("setup failed");
    return p.data.id;
  };
  return { order, provider };
}

describe("tracking number uniqueness (per carrier, tenant-scoped)", () => {
  it("refuses a number already used by another order's shipment at the same carrier — trimmed, case-insensitive — and names that order", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const w = await seedWorld();
    const carrier = await w.provider("Livreur maison");
    const [o1, o2] = [await w.order(), await w.order()];

    const first = await createShipmentAction(fd({ orderId: o1, providerId: carrier, trackingNumber: "  ABC-123 " }));
    expect(first.ok).toBe(true);
    expect((await prisma.shipment.findFirstOrThrow({ where: { orderId: o1 } })).trackingNumber).toBe("ABC-123");

    const dup = await createShipmentAction(fd({ orderId: o2, providerId: carrier, trackingNumber: "abc-123" }));
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toMatch(/^Ce numéro de suivi est déjà utilisé par la commande CMD-\d{6} chez ce transporteur\.$/);
    expect(await prisma.shipment.count({ where: { orderId: o2 } })).toBe(0);
  });

  it("a different number, or no number at all, is accepted", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const w = await seedWorld();
    const carrier = await w.provider("Livreur maison");
    const [o1, o2, o3] = [await w.order(), await w.order(), await w.order()];
    expect((await createShipmentAction(fd({ orderId: o1, providerId: carrier, trackingNumber: "N-1" }))).ok).toBe(true);
    expect((await createShipmentAction(fd({ orderId: o2, providerId: carrier, trackingNumber: "N-2" }))).ok).toBe(true);
    expect((await createShipmentAction(fd({ orderId: o3, providerId: carrier }))).ok).toBe(true);
  });

  it("the same string at ANOTHER carrier is legitimate", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const w = await seedWorld();
    const [a, b] = [await w.provider("Livreur A"), await w.provider("Livreur B")];
    const [o1, o2] = [await w.order(), await w.order()];
    expect((await createShipmentAction(fd({ orderId: o1, providerId: a, trackingNumber: "100200" }))).ok).toBe(true);
    expect((await createShipmentAction(fd({ orderId: o2, providerId: b, trackingNumber: "100200" }))).ok).toBe(true);
  });

  it("a CANCELLED shipment's number can be reused", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const w = await seedWorld();
    const carrier = await w.provider("Livreur maison");
    const [o1, o2] = [await w.order(), await w.order()];
    const first = await createShipmentAction(fd({ orderId: o1, providerId: carrier, trackingNumber: "RE-1" }));
    if (!first.ok) throw new Error("setup failed");
    const cancelled = await updateShipmentStatusAction(fd({ id: first.data.id, status: "ANNULE" }));
    expect(cancelled.ok).toBe(true);
    expect((await createShipmentAction(fd({ orderId: o2, providerId: carrier, trackingNumber: "RE-1" }))).ok).toBe(true);
  });

  it("another tenant's identical number is never seen", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const w = await seedWorld();
    const carrier = await w.provider("Livreur maison");
    const o1 = await w.order();
    await prismaBase.tenant.create({ data: { id: "tenant-trk-b", name: "B", slug: "tenant-trk-b" } });
    const otherProvider = await prismaBase.shippingProvider.create({ data: { tenantId: "tenant-trk-b", name: "Livreur maison", type: "MANUEL" } });
    const otherCustomer = await prismaBase.customer.create({ data: { tenantId: "tenant-trk-b", fullName: "B" } });
    const otherOrder = await prismaBase.order.create({ data: { tenantId: "tenant-trk-b", customerId: otherCustomer.id, subtotal: 1, total: 1 } });
    await prismaBase.shipment.create({ data: { tenantId: "tenant-trk-b", orderId: otherOrder.id, providerId: otherProvider.id, trackingNumber: "SHARED-9" } });
    expect((await createShipmentAction(fd({ orderId: o1, providerId: carrier, trackingNumber: "SHARED-9" }))).ok).toBe(true);
  });

  it("two orders racing with the same number: exactly one shipment is created", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const w = await seedWorld();
    const carrier = await w.provider("Livreur maison");
    const [o1, o2] = [await w.order(), await w.order()];
    const results = await Promise.all([
      createShipmentAction(fd({ orderId: o1, providerId: carrier, trackingNumber: "RACE-1" })),
      createShipmentAction(fd({ orderId: o2, providerId: carrier, trackingNumber: "race-1" })),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.shipment.count({ where: { trackingNumber: { equals: "race-1", mode: "insensitive" } } })).toBe(1);
  });
});

describe("pure helpers", () => {
  it("normalizeTrackingNumber / lock key", () => {
    expect(normalizeTrackingNumber("  X1 ")).toBe("X1");
    expect(normalizeTrackingNumber("   ")).toBeNull();
    expect(normalizeTrackingNumber(null)).toBeNull();
    expect(trackingNumberLockKey("p1", "AbC")).toBe(trackingNumberLockKey("p1", "abc"));
    expect(trackingNumberLockKey("p1", "abc")).not.toBe(trackingNumberLockKey("p2", "abc"));
  });
});
