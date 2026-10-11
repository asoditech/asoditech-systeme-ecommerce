import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prismaBase } from "@/lib/prisma";
import { deleteTenantAction } from "@/actions/tenants";
import { resetDb, markTenantTrial } from "../helpers/db";
import { loginAsTestUser, createTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * P3 — a trial tenant holding parcel receptions (one inspected, linked to its
 * OrderReturn; one awaiting inspection) is purged completely; another tenant
 * with the same shape is untouched. Same path as the « Supprimer » button.
 * The refusal rules themselves are covered by tenant-delete-order-returns.test.ts.
 */

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

const TENANT_MODEL_ACCESSORS = Prisma.dmmf.datamodel.models
  .filter((m) => m.fields.some((f) => f.name === "tenantId"))
  .map((m) => m.name[0].toLowerCase() + m.name.slice(1));

type CountDelegate = { count: (args?: { where?: unknown }) => Promise<number> };

async function remainingRows(tenantId: string): Promise<Record<string, number>> {
  const remaining: Record<string, number> = {};
  for (const accessor of TENANT_MODEL_ACCESSORS) {
    const n = await (prismaBase as unknown as Record<string, CountDelegate>)[accessor].count({ where: { tenantId } });
    if (n > 0) remaining[accessor] = n;
  }
  return remaining;
}

async function seedTenantWithReceptions(id: string) {
  await prismaBase.tenant.create({ data: { id, name: `Tenant ${id}`, slug: id } });
  const owner = await createTestUser({ tenantId: id, role: "OWNER" });
  const warehouse = await prismaBase.warehouse.create({ data: { tenantId: id, name: "Entrepôt", isDefault: true } });
  const product = await prismaBase.product.create({ data: { tenantId: id, name: "Prod", sku: `sku-${id}`, price: 10 } });
  const customer = await prismaBase.customer.create({ data: { tenantId: id, fullName: "Client", phone: `06${id}` } });
  const provider = await prismaBase.shippingProvider.create({ data: { tenantId: id, name: "Ozon", type: "MANUEL" } });
  const order = await prismaBase.order.create({
    data: { tenantId: id, customerId: customer.id, subtotal: 20, total: 20, shippedAt: new Date(), fulfillmentWarehouseId: warehouse.id },
  });
  const orderItem = await prismaBase.orderItem.create({
    data: { tenantId: id, orderId: order.id, productId: product.id, nameSnapshot: "Prod", skuSnapshot: `sku-${id}`, unitPrice: 10, quantity: 2, total: 20 },
  });
  const shipment = await prismaBase.shipment.create({ data: { tenantId: id, orderId: order.id, providerId: provider.id, trackingNumber: `T-${id}`, status: "RETOURNE" } });
  const orderReturn = await prismaBase.orderReturn.create({ data: { tenantId: id, orderId: order.id, idempotencyKey: `ret-${id}`, receivedById: owner.id } });
  await prismaBase.orderReturnLine.create({
    data: { tenantId: id, orderReturnId: orderReturn.id, orderItemId: orderItem.id, nameSnapshot: "Prod", skuSnapshot: `sku-${id}`, quantitySellable: 1, warehouseId: warehouse.id },
  });
  const inspected = await prismaBase.returnReception.create({
    data: { tenantId: id, shipmentId: shipment.id, orderId: order.id, warehouseId: warehouse.id, status: "INSPECTE", orderReturnId: orderReturn.id, inspectedAt: new Date(), receivedById: owner.id },
  });
  const pending = await prismaBase.returnReception.create({ data: { tenantId: id, shipmentId: shipment.id, orderId: order.id, warehouseId: warehouse.id } });
  return { inspected, pending, orderReturn, order };
}

describe("deleteTenantAction — tenant with parcel receptions", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("purges every reception (before the returns, orders and warehouses they restrict); another tenant is untouched", async () => {
    const TENANT = "tenant-with-receptions";
    const seeded = await seedTenantWithReceptions(TENANT);
    await markTenantTrial(TENANT);
    const OTHER = "tenant-with-receptions-survivor";
    const other = await seedTenantWithReceptions(OTHER);
    await markTenantTrial(OTHER);
    const otherBefore = await remainingRows(OTHER);

    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
    const result = await deleteTenantAction(formData({ id: TENANT, slugConfirmation: TENANT }));
    expect(result).toEqual({ ok: true, data: undefined });

    expect(await prismaBase.returnReception.findUnique({ where: { id: seeded.inspected.id } })).toBeNull();
    expect(await prismaBase.returnReception.findUnique({ where: { id: seeded.pending.id } })).toBeNull();
    expect(await prismaBase.orderReturn.findUnique({ where: { id: seeded.orderReturn.id } })).toBeNull();
    expect(await prismaBase.tenant.findUnique({ where: { id: TENANT } })).toBeNull();
    expect(await remainingRows(TENANT)).toEqual({});

    expect(await remainingRows(OTHER)).toEqual(otherBefore);
    expect(await prismaBase.returnReception.count({ where: { tenantId: OTHER } })).toBe(2);
    expect(await prismaBase.returnReception.findUnique({ where: { id: other.inspected.id } })).not.toBeNull();
  });

  it("the tenant.deleted audit reports the real counts for receptions, return lines and return events", async () => {
    const TENANT = "tenant-with-receptions-audit";
    await seedTenantWithReceptions(TENANT); // 2 receptions, 1 return line, 1 return event
    await markTenantTrial(TENANT);

    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
    const result = await deleteTenantAction(formData({ id: TENANT, slugConfirmation: TENANT }));
    expect(result).toEqual({ ok: true, data: undefined });

    const audit = await prismaBase.auditEvent.findFirstOrThrow({ where: { action: "tenant.deleted", entityId: TENANT } });
    const metadata = audit.metadata as { deletedCounts: Record<string, number>; totalDeleted: number };
    expect(metadata.deletedCounts).toMatchObject({ returnReception: 2, orderReturnLine: 1, orderReturn: 1, shipment: 1, order: 1 });
    // The total is the sum of the per-table counts — nothing double-counted or lost.
    expect(Object.values(metadata.deletedCounts).reduce((s, n) => s + n, 0)).toBe(metadata.totalDeleted);
  });
});
