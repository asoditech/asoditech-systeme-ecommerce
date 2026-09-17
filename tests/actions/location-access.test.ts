import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import {
  hasGlobalLocationAccess,
  requireLocationAccessForAction,
  listAccessibleActiveWarehouses,
  resolveAuthorizedDefaultWarehouseId,
} from "@/lib/auth/location-access";
import { adjustInventoryAction } from "@/actions/inventory";
import { createStockTransferAction, dispatchStockTransferAction, receiveStockTransferAction } from "@/actions/transfers";
import { createStocktakeSessionAction } from "@/actions/stocktakes";
import { createOrderAction, updateOrderStatusAction } from "@/actions/orders";
import { confirmPhysicalReturnAction } from "@/actions/returns";
import { setUserLocationsAction } from "@/actions/users";
import { resetDb, DEFAULT_TENANT_ID } from "../helpers/db";
import { loginAsTestUser, createTestUser, grantLocationAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Location Access Management v1 (docs/adr/0037-location-access-management.md).
 * Dedicated authorization coverage — the pre-existing test suites
 * (inventory/transfers/stocktakes/orders/returns/warehouses .test.ts) were
 * updated to keep exercising the AUTHORIZED path unchanged; this file is
 * specifically about the new access boundary itself: assignment,
 * OWNER/ADMIN bypass, zero-assignment deny, forged/cross-tenant ids, and
 * denial on every warehouse-scoped action.
 */

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function seedTwoWarehouses() {
  const a = await prisma.warehouse.create({ data: { name: "Dépôt Casablanca", isDefault: true } });
  const b = await prisma.warehouse.create({ data: { name: "Dépôt Rabat" } });
  return { a, b };
}

describe("UserLocation — assignment", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("setUserLocationsAction creates rows for a non-admin user and audits it", async () => {
    const admin = await loginAsTestUser({ role: "ADMIN" });
    const target = await createTestUser({ role: "WAREHOUSE" });
    const { a, b } = await seedTwoWarehouses();

    const r = await setUserLocationsAction({ userId: target.id, warehouseIds: [a.id, b.id] });
    expect(r.ok).toBe(true);

    const rows = await prisma.userLocation.findMany({ where: { userId: target.id } });
    expect(rows.map((row) => row.warehouseId).sort()).toEqual([a.id, b.id].sort());
    expect(rows.every((row) => row.createdById === admin.id)).toBe(true);

    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "user.locations_updated", entityId: target.id },
    });
    expect(audit.actorUserId).toBe(admin.id);
  });

  it("a duplicate (userId, warehouseId) pair is blocked by the unique constraint", async () => {
    const user = await createTestUser({ role: "WAREHOUSE" });
    const { a } = await seedTwoWarehouses();
    await prismaBase.userLocation.create({ data: { userId: user.id, warehouseId: a.id, tenantId: DEFAULT_TENANT_ID } });
    await expect(
      prismaBase.userLocation.create({ data: { userId: user.id, warehouseId: a.id, tenantId: DEFAULT_TENANT_ID } })
    ).rejects.toThrow();
  });

  it("setUserLocationsAction replaces the set — removing a warehouse revokes it, not just adds", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const target = await createTestUser({ role: "WAREHOUSE" });
    const { a, b } = await seedTwoWarehouses();

    await setUserLocationsAction({ userId: target.id, warehouseIds: [a.id, b.id] });
    const r = await setUserLocationsAction({ userId: target.id, warehouseIds: [a.id] });
    expect(r.ok).toBe(true);

    const rows = await prisma.userLocation.findMany({ where: { userId: target.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].warehouseId).toBe(a.id);
  });

  it("assigning OWNER/ADMIN is a documented no-op (they're already global)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const owner = await createTestUser({ role: "OWNER" });
    const { a } = await seedTwoWarehouses();

    const r = await setUserLocationsAction({ userId: owner.id, warehouseIds: [a.id] });
    expect(r.ok).toBe(false);
    expect(await prisma.userLocation.count({ where: { userId: owner.id } })).toBe(0);
  });

  it("a warehouse id belonging to another tenant is silently dropped, never assigned", async () => {
    await loginAsTestUser({ role: "ADMIN" }); // tenant A (default)
    const target = await createTestUser({ role: "WAREHOUSE" });
    const TENANT_B = "tenant-b-locations";
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    const foreignWarehouse = await prismaBase.warehouse.create({
      data: { name: "Entrepôt B", isDefault: true, tenantId: TENANT_B },
    });

    const r = await setUserLocationsAction({ userId: target.id, warehouseIds: [foreignWarehouse.id] });
    expect(r.ok).toBe(true); // succeeds, but assigns nothing
    expect(await prisma.userLocation.count({ where: { userId: target.id } })).toBe(0);

    await prismaBase.tenant.delete({ where: { id: TENANT_B } }).catch(() => {});
  });

  it("only users.manage holders (OWNER/ADMIN) may call setUserLocationsAction", async () => {
    await loginAsTestUser({ role: "MANAGER" }); // does not hold users.manage
    const target = await createTestUser({ role: "WAREHOUSE" });
    const { a } = await seedTwoWarehouses();
    await expect(setUserLocationsAction({ userId: target.id, warehouseIds: [a.id] })).rejects.toThrow(/non autorisé/i);
  });
});

describe("requireLocationAccessForAction — the core guard", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("allows an assigned warehouse", async () => {
    const user = await loginAsTestUser({ role: "WAREHOUSE" });
    const { a } = await seedTwoWarehouses();
    await grantLocationAccess(user.id, a.id);
    await expect(requireLocationAccessForAction(user, a.id)).resolves.toBeUndefined();
  });

  it("denies an unassigned warehouse", async () => {
    const user = await loginAsTestUser({ role: "WAREHOUSE" });
    const { a, b } = await seedTwoWarehouses();
    await grantLocationAccess(user.id, a.id);
    await expect(requireLocationAccessForAction(user, b.id)).rejects.toThrow(/non autorisé/i);
  });

  it("denies a forged/nonexistent warehouse id", async () => {
    const user = await loginAsTestUser({ role: "WAREHOUSE" });
    await expect(requireLocationAccessForAction(user, "does-not-exist")).rejects.toThrow(/non autorisé/i);
  });

  it("denies a warehouse belonging to another tenant", async () => {
    const user = await loginAsTestUser({ role: "WAREHOUSE" }); // tenant A
    const TENANT_B = "tenant-b-guard";
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    const foreignWarehouse = await prismaBase.warehouse.create({
      data: { name: "Entrepôt B", isDefault: true, tenantId: TENANT_B },
    });
    await expect(requireLocationAccessForAction(user, foreignWarehouse.id)).rejects.toThrow(/non autorisé/i);
    await prismaBase.tenant.delete({ where: { id: TENANT_B } }).catch(() => {});
  });

  it("OWNER bypasses — allowed on any warehouse in their own tenant with zero UserLocation rows", async () => {
    const owner = await loginAsTestUser({ role: "OWNER" });
    const { a } = await seedTwoWarehouses();
    expect(await prisma.userLocation.count({ where: { userId: owner.id } })).toBe(0);
    await expect(requireLocationAccessForAction(owner, a.id)).resolves.toBeUndefined();
  });

  it("ADMIN bypasses — same as OWNER", async () => {
    const admin = await loginAsTestUser({ role: "ADMIN" });
    const { a } = await seedTwoWarehouses();
    await expect(requireLocationAccessForAction(admin, a.id)).resolves.toBeUndefined();
  });

  it("a non-admin with zero assignments is denied every warehouse — never treated as 'all'", async () => {
    const user = await loginAsTestUser({ role: "WAREHOUSE" });
    const { a, b } = await seedTwoWarehouses();
    await expect(requireLocationAccessForAction(user, a.id)).rejects.toThrow(/non autorisé/i);
    await expect(requireLocationAccessForAction(user, b.id)).rejects.toThrow(/non autorisé/i);
  });

  it("hasGlobalLocationAccess is true only for OWNER/ADMIN", async () => {
    expect(hasGlobalLocationAccess("OWNER")).toBe(true);
    expect(hasGlobalLocationAccess("ADMIN")).toBe(true);
    for (const role of ["MANAGER", "WAREHOUSE", "CONFIRMATION", "DELIVERY", "SUPPORT", "ACCOUNTANT"] as const) {
      expect(hasGlobalLocationAccess(role)).toBe(false);
    }
  });

  it("listAccessibleActiveWarehouses returns every active warehouse for OWNER/ADMIN, only assigned ones otherwise", async () => {
    const scoped = await loginAsTestUser({ role: "WAREHOUSE" });
    const { a, b } = await seedTwoWarehouses();
    await grantLocationAccess(scoped.id, a.id);

    expect((await listAccessibleActiveWarehouses(scoped)).map((w) => w.id)).toEqual([a.id]);

    const admin = await createTestUser({ role: "ADMIN" });
    const forAdmin = await listAccessibleActiveWarehouses(admin);
    expect(forAdmin.map((w) => w.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe("inventory — location-scoped adjustments", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("denies an adjustment on an unassigned (but real, same-tenant) warehouse", async () => {
    const user = await loginAsTestUser({ role: "WAREHOUSE" });
    const { a, b } = await seedTwoWarehouses();
    await grantLocationAccess(user.id, a.id); // only A
    const product = await prisma.product.create({ data: { name: "P", sku: `S-${Math.random()}`, price: 10 } });
    await prisma.inventoryItem.create({ data: { warehouseId: b.id, productId: product.id, quantityOnHand: 10 } });

    await expect(
      adjustInventoryAction(
        formData({ productId: product.id, warehouseId: b.id, type: "RECEPTION", quantity: "5", reason: "Test" })
      )
    ).rejects.toThrow(/non autorisé/i);

    // stock untouched
    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: b.id } });
    expect(item.quantityOnHand).toBe(10);
  });

  it("allows an adjustment on an assigned warehouse — accounting unchanged", async () => {
    const user = await loginAsTestUser({ role: "WAREHOUSE" });
    const { a } = await seedTwoWarehouses();
    await grantLocationAccess(user.id, a.id);
    const product = await prisma.product.create({ data: { name: "P", sku: `S-${Math.random()}`, price: 10 } });
    await prisma.inventoryItem.create({ data: { warehouseId: a.id, productId: product.id, quantityOnHand: 10 } });

    const r = await adjustInventoryAction(
      formData({ productId: product.id, warehouseId: a.id, type: "RECEPTION", quantity: "5", reason: "Test" })
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.quantityOnHand).toBe(15);
  });
});

describe("transfers — both sides required", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  async function seedTransferable() {
    const { a: source, b: destination } = await seedTwoWarehouses();
    const product = await prisma.product.create({
      data: { name: "P", sku: `S-${Math.random()}`, price: 10, status: "ACTIF" },
    });
    await prisma.inventoryItem.create({ data: { warehouseId: source.id, productId: product.id, quantityOnHand: 20 } });
    return { source, destination, product };
  }

  const baseCreate = (source: string, destination: string, productId: string) => ({
    sourceWarehouseId: source,
    destinationWarehouseId: destination,
    notes: "",
    lines: [{ productId, variationId: null, quantitySent: 5 }],
  });

  it("source-only access is denied at create", async () => {
    const { source, destination, product } = await seedTransferable();
    const user = await loginAsTestUser({ role: "WAREHOUSE" });
    await grantLocationAccess(user.id, source.id); // destination NOT granted
    await expect(createStockTransferAction(baseCreate(source.id, destination.id, product.id))).rejects.toThrow(
      /non autorisé/i
    );
  });

  it("destination-only access is denied at create", async () => {
    const { source, destination, product } = await seedTransferable();
    const user = await loginAsTestUser({ role: "WAREHOUSE" });
    await grantLocationAccess(user.id, destination.id); // source NOT granted
    await expect(createStockTransferAction(baseCreate(source.id, destination.id, product.id))).rejects.toThrow(
      /non autorisé/i
    );
  });

  it("access to both sides allows create + dispatch + receive", async () => {
    const { source, destination, product } = await seedTransferable();
    const user = await loginAsTestUser({ role: "WAREHOUSE" });
    await grantLocationAccess(user.id, [source.id, destination.id]);

    const created = await createStockTransferAction(baseCreate(source.id, destination.id, product.id));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const dispatched = await dispatchStockTransferAction({ id: created.data.id });
    expect(dispatched.ok).toBe(true);

    const line = await prisma.stockTransferLine.findFirstOrThrow({ where: { stockTransferId: created.data.id } });
    const received = await receiveStockTransferAction({
      id: created.data.id,
      lines: [{ lineId: line.id, quantityReceived: 5 }],
    });
    expect(received.ok).toBe(true);
  });

  it("dispatch is denied without access to the source", async () => {
    const { source, destination, product } = await seedTransferable();
    const admin = await loginAsTestUser({ role: "ADMIN" });
    const created = await createStockTransferAction(baseCreate(source.id, destination.id, product.id));
    if (!created.ok) throw new Error("setup");

    mockCookieStore.clear();
    const scoped = await loginAsTestUser({ role: "WAREHOUSE" });
    await grantLocationAccess(scoped.id, destination.id); // NOT source
    await expect(dispatchStockTransferAction({ id: created.data.id })).rejects.toThrow(/non autorisé/i);
    void admin;
  });

  it("receive is denied without access to the destination", async () => {
    const { source, destination, product } = await seedTransferable();
    await loginAsTestUser({ role: "ADMIN" });
    const created = await createStockTransferAction(baseCreate(source.id, destination.id, product.id));
    if (!created.ok) throw new Error("setup");
    await dispatchStockTransferAction({ id: created.data.id });
    const line = await prisma.stockTransferLine.findFirstOrThrow({ where: { stockTransferId: created.data.id } });

    mockCookieStore.clear();
    const scoped = await loginAsTestUser({ role: "WAREHOUSE" });
    await grantLocationAccess(scoped.id, source.id); // NOT destination
    await expect(
      receiveStockTransferAction({ id: created.data.id, lines: [{ lineId: line.id, quantityReceived: 5 }] })
    ).rejects.toThrow(/non autorisé/i);
  });
});

describe("stocktakes — warehouse access enforced", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("denies creating a session on an unassigned warehouse", async () => {
    const user = await loginAsTestUser({ role: "WAREHOUSE" });
    const { a, b } = await seedTwoWarehouses();
    await grantLocationAccess(user.id, a.id);
    await expect(createStocktakeSessionAction({ warehouseId: b.id, notes: "" })).rejects.toThrow(/non autorisé/i);
    expect(await prisma.stocktakeSession.count()).toBe(0);
  });

  it("allows creating a session on an assigned warehouse", async () => {
    const user = await loginAsTestUser({ role: "WAREHOUSE" });
    const { a } = await seedTwoWarehouses();
    await grantLocationAccess(user.id, a.id);
    const r = await createStocktakeSessionAction({ warehouseId: a.id, notes: "" });
    expect(r.ok).toBe(true);
  });
});

describe("orders — fulfilment warehouse authorization", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  async function seedOrderable() {
    const { a: warehouse, b: other } = await seedTwoWarehouses();
    const product = await prisma.product.create({
      data: { name: "Coffret", sku: `SKU-LA-${Math.random()}`, price: 100, status: "ACTIF" },
    });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 10 } });
    await prisma.inventoryItem.create({ data: { warehouseId: other.id, productId: product.id, quantityOnHand: 10 } });
    const customer = await prisma.customer.create({ data: { fullName: "Client Test" } });
    return { warehouse, other, product, customer };
  }

  const orderInput = (customerId: string, productId: string, extra: Record<string, unknown> = {}) => ({
    customerId,
    paymentMethod: "PAIEMENT_LIVRAISON" as const,
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
    items: [{ productId, quantity: 1, unitPrice: 100, discount: 0 }],
    ...extra,
  });

  it("rejects a forged fulfillmentWarehouseId the user isn't assigned to", async () => {
    const { other, product, customer } = await seedOrderable();
    await loginAsTestUser({ role: "CONFIRMATION" });
    // deliberately NOT granted access to `other` — requireLocationAccessForAction throws
    await expect(
      createOrderAction(orderInput(customer.id, product.id, { fulfillmentWarehouseId: other.id }))
    ).rejects.toThrow(/non autorisé/i);
    expect(await prisma.order.count()).toBe(0);
  });

  it("accepts an authorized explicit fulfillmentWarehouseId", async () => {
    const { other, product, customer } = await seedOrderable();
    const user = await loginAsTestUser({ role: "CONFIRMATION" });
    await grantLocationAccess(user.id, other.id);
    const r = await createOrderAction(orderInput(customer.id, product.id, { fulfillmentWarehouseId: other.id }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const order = await prisma.order.findUniqueOrThrow({ where: { id: r.data.id } });
    expect(order.fulfillmentWarehouseId).toBe(other.id);
  });

  it("with no explicit choice, a scoped user with exactly one authorized warehouse gets it as the default", async () => {
    const { other, product, customer } = await seedOrderable(); // tenant default is `warehouse`, not `other`
    const user = await loginAsTestUser({ role: "CONFIRMATION" });
    await grantLocationAccess(user.id, other.id); // only the NON-default warehouse
    const r = await createOrderAction(orderInput(customer.id, product.id));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const order = await prisma.order.findUniqueOrThrow({ where: { id: r.data.id } });
    expect(order.fulfillmentWarehouseId).toBe(other.id); // never the unauthorized tenant default
  });

  it("with no explicit choice and zero assigned warehouses, the order is rejected — never silently assigned", async () => {
    const { product, customer } = await seedOrderable();
    await loginAsTestUser({ role: "CONFIRMATION" }); // zero UserLocation rows
    const r = await createOrderAction(orderInput(customer.id, product.id));
    expect(r).toMatchObject({ ok: false });
    expect(await prisma.order.count()).toBe(0);
  });

  it("OWNER/ADMIN keep the exact pre-existing default-resolution behaviour (the tenant default, no grant needed)", async () => {
    const { warehouse, product, customer } = await seedOrderable();
    await loginAsTestUser({ role: "OWNER" });
    const r = await createOrderAction(orderInput(customer.id, product.id));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const order = await prisma.order.findUniqueOrThrow({ where: { id: r.data.id } });
    expect(order.fulfillmentWarehouseId).toBe(warehouse.id);
  });

  it("resolveAuthorizedDefaultWarehouseId never returns a warehouse outside the caller's own set", async () => {
    const { other, customer } = await seedOrderable();
    void customer;
    const user = await loginAsTestUser({ role: "WAREHOUSE" });
    await grantLocationAccess(user.id, other.id);
    const resolved = await resolveAuthorizedDefaultWarehouseId(user);
    expect(resolved).toBe(other.id);
  });
});

describe("physical returns — location-scoped", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  async function createShippedOrder(warehouseId?: string) {
    const { a: defaultWarehouse } = await seedTwoWarehouses();
    const product = await prisma.product.create({
      data: { name: "Coffret", sku: `SKU-RET-LA-${Math.random()}`, price: 100, status: "ACTIF" },
    });
    const target = warehouseId ?? defaultWarehouse.id;
    await prisma.inventoryItem.create({ data: { warehouseId: target, productId: product.id, quantityOnHand: 10 } });
    const customer = await prisma.customer.create({ data: { fullName: "Client Retour" } });

    await loginAsTestUser({ role: "ADMIN" }); // global — no grant needed to set up the shipped order
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
      items: [{ productId: product.id, quantity: 5, unitPrice: 100, discount: 0 }],
      fulfillmentWarehouseId: target,
    });
    if (!created.ok) throw new Error("setup failed: " + JSON.stringify(created));
    const orderId = created.data.id;
    await updateOrderStatusAction(formData({ id: orderId, status: "CONFIRMEE" }));
    await updateOrderStatusAction(formData({ id: orderId, status: "EN_PREPARATION" }));
    const shipped = await updateOrderStatusAction(formData({ id: orderId, status: "EXPEDIEE" }));
    if (!shipped.ok) throw new Error("setup failed to ship");
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
    return { order, warehouseId: target };
  }

  it("denies a return without location access to the order's fulfilment warehouse", async () => {
    const { order } = await createShippedOrder();
    mockCookieStore.clear();
    await loginAsTestUser({ role: "MANAGER" }); // holds orders.return, but zero UserLocation rows
    await expect(
      confirmPhysicalReturnAction({
        orderId: order.id,
        idempotencyKey: randomUUID(),
        lines: [{ orderItemId: order.items[0].id, quantitySellable: 1, quantityDamaged: 0 }],
      })
    ).rejects.toThrow(/non autorisé/i);
  });

  it("allows a return with location access to the order's fulfilment warehouse — accounting unchanged", async () => {
    const { order, warehouseId } = await createShippedOrder();
    mockCookieStore.clear();
    const user = await loginAsTestUser({ role: "MANAGER" });
    await grantLocationAccess(user.id, warehouseId);

    const result = await confirmPhysicalReturnAction({
      orderId: order.id,
      idempotencyKey: randomUUID(),
      lines: [{ orderItemId: order.items[0].id, quantitySellable: 5, quantityDamaged: 0 }],
    });
    expect(result.ok).toBe(true);

    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId } });
    expect(item.quantityOnHand).toBe(10); // unchanged from before shipment: 10 - 5 + 5
  });
});
