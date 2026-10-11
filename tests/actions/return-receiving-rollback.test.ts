import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { inspectReturnReceptionAction, receiveReturnParcelAction } from "@/actions/return-receiving";
import { getCurrentUser } from "@/lib/auth/session";
import { resetDb } from "../helpers/db";
import { loginAsTestUser, grantLocationAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * P3 — an unexpected failure INSIDE the inspection transaction (here the
 * audit write, which runs AFTER the return event, its lines and the
 * RETOUR / ENDOMMAGE stock movements) must roll everything back: no event,
 * no line, no movement, no stock change, no audit, and the reception stays
 * awaiting inspection. The audit module is the real one except for the one
 * forced failure.
 */
const failOn = vi.hoisted(() => ({ action: null as string | null }));

vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return {
    ...actual,
    recordAuditEvent: vi.fn(async (input: Parameters<typeof actual.recordAuditEvent>[0], tx?: Parameters<typeof actual.recordAuditEvent>[1]) => {
      if (failOn.action && input.action === failOn.action) throw new Error("forced audit failure");
      return actual.recordAuditEvent(input, tx);
    }),
  };
});

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  failOn.action = null;
});
afterEach(async () => {
  failOn.action = null;
  await resetDb();
  mockCookieStore.clear();
});

async function seed() {
  const user = await loginAsTestUser({ role: "MANAGER" });
  const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt", isDefault: true } });
  await grantLocationAccess(user.id, warehouse.id);
  const product = await prisma.product.create({ data: { name: "Sac", sku: `RB-${randomUUID()}`, price: 100, status: "ACTIF" } });
  const item = await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 5 } });
  const customer = await prisma.customer.create({ data: { fullName: "Client" } });
  const provider = await prisma.shippingProvider.create({ data: { name: "Ozon", type: "MANUEL" } });
  const order = await prisma.order.create({
    data: {
      customerId: customer.id,
      subtotal: 300,
      total: 300,
      status: "EXPEDIEE",
      shippedAt: new Date(),
      fulfillmentWarehouseId: warehouse.id,
      items: { create: [{ productId: product.id, nameSnapshot: "Sac", skuSnapshot: "SAC", unitPrice: 100, quantity: 3, total: 300 }] },
    },
    include: { items: true },
  });
  const shipment = await prisma.shipment.create({ data: { orderId: order.id, providerId: provider.id, trackingNumber: "RB-TRACK", status: "RETOURNE" } });
  return { item, order, shipment };
}

describe("inspection — atomic rollback on an unexpected failure", () => {
  it("a failure after the stock movements leaves no event, line, movement, stock change or audit, and the reception awaiting inspection", async () => {
    const { item, order, shipment } = await seed();
    const received = await receiveReturnParcelAction({ shipmentId: shipment.id });
    expect(received.ok && received.data.ok).toBe(true);
    const receptionId = received.ok && received.data.ok ? received.data.receptionId : "";
    const auditsBefore = await prisma.auditEvent.count();

    failOn.action = "order.return_confirmed";
    await expect(
      inspectReturnReceptionAction({
        receptionId,
        idempotencyKey: randomUUID(),
        entries: [
          { orderItemId: order.items[0].id, condition: "SELLABLE", quantity: 2 },
          { orderItemId: order.items[0].id, condition: "DAMAGED", quantity: 1 },
        ],
      })
    ).rejects.toThrow("forced audit failure");

    expect(await prisma.orderReturn.count()).toBe(0);
    expect(await prisma.orderReturnLine.count()).toBe(0);
    expect(await prisma.inventoryMovement.count({ where: { type: { in: ["RETOUR", "ENDOMMAGE"] } } })).toBe(0);
    const row = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.quantityOnHand).toBe(5);
    expect(row.quantityDamaged).toBe(0);
    expect(await prisma.auditEvent.count()).toBe(auditsBefore);
    const reception = await prisma.returnReception.findUniqueOrThrow({ where: { id: receptionId } });
    expect(reception).toMatchObject({ status: "A_INSPECTER", orderReturnId: null, inspectedAt: null });

    // Once the cause is gone, the same parcel inspects normally.
    failOn.action = null;
    const ok = await inspectReturnReceptionAction({
      receptionId,
      idempotencyKey: randomUUID(),
      entries: [{ orderItemId: order.items[0].id, condition: "SELLABLE", quantity: 2 }],
    });
    expect(ok.ok).toBe(true);
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantityOnHand).toBe(7);
  });

  it("a failure while recording the reception persists no reception", async () => {
    const { shipment } = await seed();
    failOn.action = "order.return_received";
    await expect(receiveReturnParcelAction({ shipmentId: shipment.id })).rejects.toThrow("forced audit failure");
    expect(await prisma.returnReception.count()).toBe(0);
    expect((await getCurrentUser()) !== null).toBe(true);
  });
});
