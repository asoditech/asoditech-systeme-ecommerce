import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { inspectReturnReceptionAction, receiveReturnParcelAction } from "@/actions/return-receiving";
import { inspectReturnReception } from "@/lib/returns/reception";
import { resetDb } from "../helpers/db";
import { loginAsTestUser, grantLocationAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * P3 — invalid inspection requests through the real Server Action. Each is
 * rejected by the input schema BEFORE the inspection service runs (the
 * service is the real one, wrapped only to count calls), so no transaction
 * opens and nothing is written: the reception stays A_INSPECTER, with no
 * return event, line, movement, stock change or audit.
 */
vi.mock("@/lib/returns/reception", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/returns/reception")>();
  return { ...actual, inspectReturnReception: vi.fn(actual.inspectReturnReception) };
});

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  vi.mocked(inspectReturnReception).mockClear();
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(async () => {
  expect(fetchSpy).not.toHaveBeenCalled(); // no carrier API
  fetchSpy.mockRestore();
  vi.restoreAllMocks();
  await resetDb();
  mockCookieStore.clear();
});

/** A received parcel awaiting inspection, operated by a MANAGER with access to its warehouse. */
async function receivedParcel() {
  const user = await loginAsTestUser({ role: "MANAGER" });
  const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt", isDefault: true } });
  await grantLocationAccess(user.id, warehouse.id);
  const product = await prisma.product.create({ data: { name: "Sac", sku: `VAL-${randomUUID()}`, price: 100, status: "ACTIF" } });
  const item = await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 5 } });
  const customer = await prisma.customer.create({ data: { fullName: "Client" } });
  const provider = await prisma.shippingProvider.create({ data: { name: "OzonExpress", type: "API", providerKey: "ozonexpress" } });
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
  const shipment = await prisma.shipment.create({ data: { orderId: order.id, providerId: provider.id, trackingNumber: `VAL-${randomUUID().slice(0, 6)}`, status: "RETOURNE" } });
  const received = await receiveReturnParcelAction({ shipmentId: shipment.id });
  if (!received.ok || !received.data.ok) throw new Error("setup: reception failed");
  return { receptionId: received.data.receptionId, orderItemId: order.items[0].id, item, warehouse };
}

type Case = { name: string; build: (ctx: { receptionId: string; orderItemId: string; warehouseId: string }) => unknown };

const CASES: Case[] = [
  { name: "entries: [] (no unit at all)", build: ({ receptionId }) => ({ receptionId, idempotencyKey: randomUUID(), entries: [] }) },
  {
    name: "an entry with quantity: 0",
    build: ({ receptionId, orderItemId }) => ({ receptionId, idempotencyKey: randomUUID(), entries: [{ orderItemId, condition: "SELLABLE", quantity: 0 }] }),
  },
  {
    name: "an entry without a condition",
    build: ({ receptionId, orderItemId }) => ({ receptionId, idempotencyKey: randomUUID(), entries: [{ orderItemId, quantity: 1 }] }),
  },
  {
    name: "a valid entry next to an invalid one (whole request rejected, nothing partial)",
    build: ({ receptionId, orderItemId }) => ({
      receptionId,
      idempotencyKey: randomUUID(),
      entries: [
        { orderItemId, condition: "SELLABLE", quantity: 1 },
        { orderItemId, condition: "SELLABLE", quantity: 0 },
      ],
    }),
  },
  {
    name: "forged top-level tenantId / warehouseId / orderId",
    build: ({ receptionId, orderItemId, warehouseId }) => ({
      receptionId,
      idempotencyKey: randomUUID(),
      tenantId: "another-tenant",
      warehouseId,
      orderId: "forged-order",
      entries: [{ orderItemId, condition: "SELLABLE", quantity: 1 }],
    }),
  },
  {
    name: "a forged field inside an entry (warehouseId)",
    build: ({ receptionId, orderItemId, warehouseId }) => ({
      receptionId,
      idempotencyKey: randomUUID(),
      entries: [{ orderItemId, condition: "SELLABLE", quantity: 1, warehouseId }],
    }),
  },
];

describe("inspectReturnReceptionAction — invalid requests are rejected before the inspection service", () => {
  it.each(CASES)("$name", async ({ build }) => {
    const { receptionId, orderItemId, item, warehouse } = await receivedParcel();
    const auditsBefore = await prisma.auditEvent.count();
    const txSpy = vi.spyOn(prisma, "$transaction");

    const result = await inspectReturnReceptionAction(build({ receptionId, orderItemId, warehouseId: warehouse.id }) as never);

    expect(result).toMatchObject({ ok: false, error: "Champs invalides." });
    expect(inspectReturnReception).not.toHaveBeenCalled();
    expect(txSpy).not.toHaveBeenCalled();
    txSpy.mockRestore();

    const reception = await prisma.returnReception.findUniqueOrThrow({ where: { id: receptionId } });
    expect(reception).toMatchObject({ status: "A_INSPECTER", orderReturnId: null, inspectedAt: null, inspectedById: null });
    expect(await prisma.orderReturn.count()).toBe(0);
    expect(await prisma.orderReturnLine.count()).toBe(0);
    expect(await prisma.inventoryMovement.count()).toBe(0);
    const stock = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(stock).toMatchObject({ quantityOnHand: 5, quantityDamaged: 0 });
    expect(await prisma.auditEvent.count()).toBe(auditsBefore);
  });

  it("control: the same reception with a valid request DOES reach the service and completes", async () => {
    const { receptionId, orderItemId, item } = await receivedParcel();
    const result = await inspectReturnReceptionAction({
      receptionId,
      idempotencyKey: randomUUID(),
      entries: [{ orderItemId, condition: "SELLABLE", quantity: 1 }],
    });
    expect(result.ok).toBe(true);
    expect(inspectReturnReception).toHaveBeenCalledTimes(1);
    expect((await prisma.returnReception.findUniqueOrThrow({ where: { id: receptionId } })).status).toBe("INSPECTE");
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantityOnHand).toBe(6);
  });
});
