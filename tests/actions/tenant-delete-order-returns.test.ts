import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prismaBase } from "@/lib/prisma";
import { deleteTenantAction } from "@/actions/tenants";
import { resetDb, markTenantTrial } from "../helpers/db";
import { loginAsTestUser, createTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Regression for the production blocker on the « Supprimer » button
 * (docs/adr/0053): `order_returns.orderId` and `order_return_lines.warehouseId`
 * are ON DELETE RESTRICT and neither table is part of BACKUP_MODELS, so a
 * trial tenant holding a single physical return could not be purged — the
 * `orders` delete hit `order_returns_orderId_fkey` and the whole transaction
 * rolled back. Goes through deleteTenantAction, the exact path the button uses.
 */

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

/** Every model carrying `tenantId`, straight from the schema — same source as the purge's own zero-row proof. */
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

/** Minimum order + a physical return with one line and its RETOUR stock movement. */
async function seedTenantWithOrderReturn(id: string) {
  await prismaBase.tenant.create({ data: { id, name: `Tenant ${id}`, slug: id } });
  const owner = await createTestUser({ tenantId: id, role: "OWNER" });

  const warehouse = await prismaBase.warehouse.create({ data: { tenantId: id, name: "Entrepôt", isDefault: true } });
  const product = await prismaBase.product.create({ data: { tenantId: id, name: "Prod", sku: `sku-${id}`, price: 10 } });
  const customer = await prismaBase.customer.create({ data: { tenantId: id, fullName: "Client", phone: `06${id}` } });

  const order = await prismaBase.order.create({
    data: { tenantId: id, customerId: customer.id, subtotal: 10, total: 10, fulfillmentWarehouseId: warehouse.id },
  });
  const orderItem = await prismaBase.orderItem.create({
    data: {
      tenantId: id,
      orderId: order.id,
      productId: product.id,
      nameSnapshot: "Prod",
      skuSnapshot: `sku-${id}`,
      unitPrice: 10,
      quantity: 1,
      total: 10,
    },
  });

  const orderReturn = await prismaBase.orderReturn.create({
    data: { tenantId: id, orderId: order.id, idempotencyKey: `ret-${id}`, receivedById: owner.id },
  });
  const returnLine = await prismaBase.orderReturnLine.create({
    data: {
      tenantId: id,
      orderReturnId: orderReturn.id,
      orderItemId: orderItem.id,
      nameSnapshot: "Prod",
      skuSnapshot: `sku-${id}`,
      quantitySellable: 1,
      warehouseId: warehouse.id,
    },
  });

  const inventoryItem = await prismaBase.inventoryItem.create({
    data: { tenantId: id, warehouseId: warehouse.id, productId: product.id, quantityOnHand: 1 },
  });
  await prismaBase.inventoryMovement.create({
    data: {
      tenantId: id,
      inventoryItemId: inventoryItem.id,
      warehouseId: warehouse.id,
      type: "RETOUR",
      quantity: 1,
      orderId: order.id,
      orderReturnId: orderReturn.id,
    },
  });

  return { owner, warehouse, product, order, orderItem, orderReturn, returnLine };
}

describe("deleteTenantAction — tenant with physical order returns", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("purges a TRIALING tenant holding an order return, leaving no tenant-owned row behind", async () => {
    const TENANT = "tenant-with-returns";
    const seeded = await seedTenantWithOrderReturn(TENANT);
    await markTenantTrial(TENANT);
    expect(await prismaBase.orderReturn.count({ where: { tenantId: TENANT } })).toBe(1);
    expect(await prismaBase.orderReturnLine.count({ where: { tenantId: TENANT } })).toBe(1);

    // Another trial tenant with the exact same shape (order + return + line +
    // movement) must come out byte-for-byte untouched: the purge's deleteMany({})
    // and its completeness count are both tenant-scoped.
    const OTHER = "tenant-with-returns-survivor";
    const other = await seedTenantWithOrderReturn(OTHER);
    await markTenantTrial(OTHER);
    const otherBefore = await remainingRows(OTHER);

    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
    const result = await deleteTenantAction(formData({ id: TENANT, slugConfirmation: TENANT }));
    expect(result).toEqual({ ok: true, data: undefined });

    expect(await prismaBase.tenant.findUnique({ where: { id: TENANT } })).toBeNull();
    expect(await prismaBase.order.findUnique({ where: { id: seeded.order.id } })).toBeNull();
    expect(await prismaBase.orderItem.findUnique({ where: { id: seeded.orderItem.id } })).toBeNull();
    expect(await prismaBase.orderReturn.findUnique({ where: { id: seeded.orderReturn.id } })).toBeNull();
    expect(await prismaBase.orderReturnLine.findUnique({ where: { id: seeded.returnLine.id } })).toBeNull();
    expect(await prismaBase.warehouse.findUnique({ where: { id: seeded.warehouse.id } })).toBeNull();
    expect(await prismaBase.product.findUnique({ where: { id: seeded.product.id } })).toBeNull();
    expect(await prismaBase.user.findUnique({ where: { id: seeded.owner.id } })).toBeNull();
    // Every tenant-owned table, from the schema itself — not just the ones seeded above.
    expect(await remainingRows(TENANT)).toEqual({});

    expect(await prismaBase.tenant.findUnique({ where: { id: OTHER } })).not.toBeNull();
    expect(await remainingRows(OTHER)).toEqual(otherBefore);
    expect(await prismaBase.orderReturn.findUnique({ where: { id: other.orderReturn.id } })).not.toBeNull();
    expect(await prismaBase.orderReturnLine.findUnique({ where: { id: other.returnLine.id } })).not.toBeNull();
    expect(await prismaBase.order.findUnique({ where: { id: other.order.id } })).not.toBeNull();
  });

  it("refuses a tenant whose subscription is not TRIALING, and deletes nothing", async () => {
    const TENANT = "tenant-active-sub";
    await seedTenantWithOrderReturn(TENANT);
    await markTenantTrial(TENANT);
    await prismaBase.tenantSubscription.update({ where: { tenantId: TENANT }, data: { status: "ACTIVE" } });
    const before = await remainingRows(TENANT);

    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
    const result = await deleteTenantAction(formData({ id: TENANT, slugConfirmation: TENANT }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/essai/);

    expect(await prismaBase.tenant.findUnique({ where: { id: TENANT } })).not.toBeNull();
    expect(await remainingRows(TENANT)).toEqual(before);
  });

  it("refuses a tenant with no subscription at all", async () => {
    const TENANT = "tenant-no-sub";
    await seedTenantWithOrderReturn(TENANT);

    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
    const result = await deleteTenantAction(formData({ id: TENANT, slugConfirmation: TENANT }));
    expect(result.ok).toBe(false);
    expect(await prismaBase.tenant.findUnique({ where: { id: TENANT } })).not.toBeNull();
  });

  it("refuses a TRIALING tenant that holds a platform admin account, and deletes nothing", async () => {
    const TENANT = "tenant-with-platform-admin";
    await seedTenantWithOrderReturn(TENANT);
    await createTestUser({ tenantId: TENANT, role: "ADMIN", isPlatformAdmin: true });
    await markTenantTrial(TENANT);
    const before = await remainingRows(TENANT);

    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
    const result = await deleteTenantAction(formData({ id: TENANT, slugConfirmation: TENANT }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/administrateur de la plateforme/);

    expect(await prismaBase.tenant.findUnique({ where: { id: TENANT } })).not.toBeNull();
    expect(await remainingRows(TENANT)).toEqual(before);
  });

  it("is refused for a caller who is not a platform admin", async () => {
    const TENANT = "tenant-non-admin-caller";
    await seedTenantWithOrderReturn(TENANT);
    await markTenantTrial(TENANT);

    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: false });
    await expect(deleteTenantAction(formData({ id: TENANT, slugConfirmation: TENANT }))).rejects.toThrow();
    expect(await prismaBase.tenant.findUnique({ where: { id: TENANT } })).not.toBeNull();
  });
});
