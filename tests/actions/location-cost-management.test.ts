import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { updateLocationCostAction } from "@/actions/inventory";
import { createStockTransferAction, dispatchStockTransferAction, receiveStockTransferAction } from "@/actions/transfers";
import { createSaleAction } from "@/actions/sales";
import { createOrderAction } from "@/actions/orders";
import { backfillProductCostSnapshotsAction } from "@/actions/products";
import { updateTransferCostOverrideAction } from "@/actions/settings";
import { getStockValuationReport } from "@/lib/queries/reports/stock-valuation";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser, grantLocationAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Phase 2.5 — managing a location's current purchase cost by hand
 * (InventoryItem.currentUnitCost): set / replace / « Utiliser le coût global ».
 * finance.view + location access; touches only that row's location cost.
 */

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

async function setOverride(on: boolean) {
  await prisma.businessSettings.upsert({
    where: { tenantId: "default" },
    update: { transferPurchaseCostOverrideEnabled: on },
    create: { transferPurchaseCostOverrideEnabled: on },
  });
}

async function seed() {
  const general = await prisma.warehouse.create({ data: { name: "Stock général", isDefault: true } });
  const casa = await prisma.warehouse.create({ data: { name: "Magasin Casablanca", type: "MAGASIN" } });
  const channel = await prisma.salesChannel.create({ data: { name: "Caisse Casablanca", kind: "OFFLINE" } });
  await prisma.salesChannelLocation.create({ data: { salesChannelId: channel.id, warehouseId: casa.id } });
  const product = await prisma.product.create({
    data: { name: "Sac cuir", sku: `SAC-${Math.random()}`, price: 180, salePrice: 170, cost: 100, status: "ACTIF" },
  });
  await prisma.productSalesChannel.create({ data: { productId: product.id, salesChannelId: channel.id } });
  const generalItem = await prisma.inventoryItem.create({ data: { warehouseId: general.id, productId: product.id, quantityOnHand: 20 } });
  const casaItem = await prisma.inventoryItem.create({ data: { warehouseId: casa.id, productId: product.id, quantityOnHand: 10 } });
  return { general, casa, channel, product, generalItem, casaItem };
}

const item = (id: string) => prisma.inventoryItem.findUniqueOrThrow({ where: { id } });

async function sellAtCasa(s: { casa: { id: string }; channel: { id: string }; product: { id: string } }) {
  const r = await createSaleAction({
    salesChannelId: s.channel.id,
    warehouseId: s.casa.id,
    idempotencyKey: randomUUID(),
    lines: [{ productId: s.product.id, quantity: 1 }],
    payments: [{ method: "ESPECES", amount: 170 }],
  });
  if (!r.ok) throw new Error(r.error);
  return prisma.saleLine.findFirstOrThrow({ where: { saleId: r.data.id } });
}

beforeEach(async () => {
  await resetDb();
  await setTestBusinessMode("ONLINE_AND_OFFLINE");
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

describe("A/B/C — set, replace, clear", () => {
  it("A — finance.view sets then replaces a location cost; audited", async () => {
    const admin = await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    const r = await updateLocationCostAction({ inventoryItemId: s.casaItem.id, cost: 110 });
    expect(r).toMatchObject({ ok: true, data: { cost: "110" } });
    expect(num((await item(s.casaItem.id)).currentUnitCost)).toBe(110);
    expect((await updateLocationCostAction({ inventoryItemId: s.casaItem.id, cost: 120.5 })).ok).toBe(true);
    expect(num((await item(s.casaItem.id)).currentUnitCost)).toBe(120.5);

    const audits = await prisma.auditEvent.findMany({ where: { action: "inventory.location_cost_updated", entityId: s.casaItem.id }, orderBy: { createdAt: "asc" } });
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ actorUserId: admin.id, previousValue: { currentUnitCost: null }, newValue: { currentUnitCost: "110" } });
    // Only that row: General Stock untouched.
    expect((await item(s.generalItem.id)).currentUnitCost).toBeNull();
  });

  it("B/C — « Utiliser le coût global » clears it; the effective cost falls back to product, then variation cost", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    await updateLocationCostAction({ inventoryItemId: s.casaItem.id, cost: 110 });
    expect(num((await sellAtCasa(s)).costSnapshot)).toBe(110);

    expect((await updateLocationCostAction({ inventoryItemId: s.casaItem.id, cost: null })).ok).toBe(true);
    expect((await item(s.casaItem.id)).currentUnitCost).toBeNull();
    expect(num((await sellAtCasa(s)).costSnapshot)).toBe(100); // product global cost
    const casaRow = (await getStockValuationReport()).rows.find((r) => r.warehouseName === "Magasin Casablanca");
    expect(casaRow?.unitCost).toBe(100);

    // variation: location → variation cost
    const v = await prisma.productVariation.create({
      data: { productId: s.product.id, sku: `SAC-L-${Math.random()}`, attributes: { Taille: "L" }, price: 190, cost: 95 },
    });
    const vItem = await prisma.inventoryItem.create({ data: { warehouseId: s.casa.id, variationId: v.id, quantityOnHand: 3, currentUnitCost: 130 } });
    await updateLocationCostAction({ inventoryItemId: vItem.id, cost: null });
    const vRow = (await getStockValuationReport()).rows.find((r) => r.sku === v.sku);
    expect(vRow?.unitCost).toBe(95);
  });

  it("rejects a negative or non-numeric cost; nothing changes", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    await updateLocationCostAction({ inventoryItemId: s.casaItem.id, cost: 110 });
    expect((await updateLocationCostAction({ inventoryItemId: s.casaItem.id, cost: -1 })).ok).toBe(false);
    expect((await updateLocationCostAction({ inventoryItemId: s.casaItem.id, cost: Number.NaN })).ok).toBe(false);
    expect(num((await item(s.casaItem.id)).currentUnitCost)).toBe(110);
  });
});

describe("D/E/F/G — permissions and isolation", () => {
  it("D/E — a user without finance.view can neither set nor clear", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    await updateLocationCostAction({ inventoryItemId: s.casaItem.id, cost: 110 });

    const wh = await loginAsTestUser({ role: "WAREHOUSE" }); // inventory roles, no finance.view
    await grantLocationAccess(wh.id, [s.casa.id]);
    await expect(updateLocationCostAction({ inventoryItemId: s.casaItem.id, cost: 90 })).rejects.toThrow(/non autorisé/i);
    await expect(updateLocationCostAction({ inventoryItemId: s.casaItem.id, cost: null })).rejects.toThrow(/non autorisé/i);
    expect(num((await item(s.casaItem.id)).currentUnitCost)).toBe(110);
  });

  it("G — finance.view is not enough without access to that location", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    const manager = await loginAsTestUser({ role: "MANAGER" }); // has finance.view
    await grantLocationAccess(manager.id, [s.casa.id]);
    expect((await updateLocationCostAction({ inventoryItemId: s.casaItem.id, cost: 115 })).ok).toBe(true);
    await expect(updateLocationCostAction({ inventoryItemId: s.generalItem.id, cost: 90 })).rejects.toThrow();
    expect((await item(s.generalItem.id)).currentUnitCost).toBeNull();
  });

  it("F — another tenant's stock row is « introuvable » and left untouched", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await seed();
    const tenantB = "tenant-b-loc-cost";
    await prismaBase.tenant.create({ data: { id: tenantB, name: "B", slug: tenantB } });
    const whB = await prismaBase.warehouse.create({ data: { name: "WB", tenantId: tenantB } });
    const pB = await prismaBase.product.create({ data: { name: "PB", sku: `PB-${Math.random()}`, price: 10, cost: 5, tenantId: tenantB } });
    const itemB = await prismaBase.inventoryItem.create({ data: { warehouseId: whB.id, productId: pB.id, quantityOnHand: 1, currentUnitCost: 7, tenantId: tenantB } });

    const r = await updateLocationCostAction({ inventoryItemId: itemB.id, cost: 999 });
    expect(r).toMatchObject({ ok: false, error: "Stock introuvable." });
    expect(num((await prismaBase.inventoryItem.findUniqueOrThrow({ where: { id: itemB.id } })).currentUnitCost)).toBe(7);
  });
});

describe("H/I — history is never rewritten", () => {
  it("transfer movement, transfer line, sale and order snapshots keep their recorded cost", async () => {
    await setOverride(true);
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();

    const created = await createStockTransferAction({
      sourceWarehouseId: s.general.id,
      destinationWarehouseId: s.casa.id,
      notes: "",
      lines: [{ productId: s.product.id, variationId: null, quantitySent: 5, destinationUnitCost: 110 }],
    });
    if (!created.ok) throw new Error(created.error);
    await dispatchStockTransferAction({ id: created.data.id });
    const line = await prisma.stockTransferLine.findFirstOrThrow({ where: { stockTransferId: created.data.id } });
    await receiveStockTransferAction({ id: created.data.id, lines: [{ lineId: line.id, quantityReceived: 5 }] });

    const saleLine = await sellAtCasa(s);
    const customer = await prisma.customer.create({ data: { fullName: "Client", phone: "0600000001" } });
    const order = await createOrderAction({
      customerId: customer.id, paymentMethod: "PAIEMENT_LIVRAISON", shippingCost: 0, discountTotal: 0, currency: "MAD",
      fulfillmentWarehouseId: s.casa.id,
      items: [{ productId: s.product.id, quantity: 1, unitPrice: 180, discount: 0 }],
    } as never);
    if (!order.ok) throw new Error(order.error);
    const orderItem = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.data.id } });
    expect([num(saleLine.costSnapshot), num(orderItem.costSnapshot)]).toEqual([110, 110]);

    await updateLocationCostAction({ inventoryItemId: s.casaItem.id, cost: 140 });
    await updateLocationCostAction({ inventoryItemId: s.casaItem.id, cost: null });

    const entree = await prisma.inventoryMovement.findFirstOrThrow({ where: { stockTransferId: created.data.id, type: "TRANSFERT_ENTREE" } });
    expect(num(entree.unitCost)).toBe(110);
    expect(num((await prisma.stockTransferLine.findUniqueOrThrow({ where: { id: line.id } })).destinationUnitCost)).toBe(110);
    expect(num((await prisma.saleLine.findUniqueOrThrow({ where: { id: saleLine.id } })).costSnapshot)).toBe(110);
    expect(num((await prisma.inventoryMovement.findFirstOrThrow({ where: { saleId: saleLine.saleId } })).unitCost)).toBe(110);
    expect(num((await prisma.orderItem.findUniqueOrThrow({ where: { id: orderItem.id } })).costSnapshot)).toBe(110);
  });
});

describe("J — setting OFF", () => {
  it("manual management works with the setting off, and turning it off erases nothing", async () => {
    await setOverride(true);
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    await updateLocationCostAction({ inventoryItemId: s.casaItem.id, cost: 110 });

    const f = new FormData();
    f.set("transferPurchaseCostOverrideEnabled", "false");
    expect((await updateTransferCostOverrideAction(f)).ok).toBe(true);
    expect(num((await item(s.casaItem.id)).currentUnitCost)).toBe(110);

    expect((await updateLocationCostAction({ inventoryItemId: s.casaItem.id, cost: 105 })).ok).toBe(true);
    expect(num((await item(s.casaItem.id)).currentUnitCost)).toBe(105);
    expect((await updateLocationCostAction({ inventoryItemId: s.casaItem.id, cost: null })).ok).toBe(true);
    expect((await item(s.casaItem.id)).currentUnitCost).toBeNull();
  });
});

describe("K — Backfill", () => {
  it("fills empty historical order snapshots with the global cost and never touches location costs", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    await prisma.product.update({ where: { id: s.product.id }, data: { cost: null } });
    const customer = await prisma.customer.create({ data: { fullName: "Client", phone: "0600000002" } });
    const order = await createOrderAction({
      customerId: customer.id, paymentMethod: "PAIEMENT_LIVRAISON", shippingCost: 0, discountTotal: 0, currency: "MAD",
      fulfillmentWarehouseId: s.general.id,
      items: [{ productId: s.product.id, quantity: 1, unitPrice: 180, discount: 0 }],
    } as never);
    if (!order.ok) throw new Error(order.error);
    expect((await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.data.id } })).costSnapshot).toBeNull();

    await prisma.product.update({ where: { id: s.product.id }, data: { cost: 100 } });
    await updateLocationCostAction({ inventoryItemId: s.casaItem.id, cost: 110 });
    await updateLocationCostAction({ inventoryItemId: s.generalItem.id, cost: 120 });

    const f = new FormData();
    f.set("productId", s.product.id);
    const r = await backfillProductCostSnapshotsAction(f);
    expect(r).toMatchObject({ ok: true, data: { updated: 1 } });
    expect(num((await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.data.id } })).costSnapshot)).toBe(100);
    expect([num((await item(s.casaItem.id)).currentUnitCost), num((await item(s.generalItem.id)).currentUnitCost)]).toEqual([110, 120]);
  });
});

describe("L/M — global cost and selling prices", () => {
  it("setting and clearing a location cost never changes the product/variation cost or any price", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    const v = await prisma.productVariation.create({
      data: { productId: s.product.id, sku: `SAC-M-${Math.random()}`, attributes: { Taille: "M" }, price: 190, salePrice: 185, cost: 95 },
    });
    const vItem = await prisma.inventoryItem.create({ data: { warehouseId: s.casa.id, variationId: v.id, quantityOnHand: 2 } });

    for (const cost of [110, null]) {
      await updateLocationCostAction({ inventoryItemId: s.casaItem.id, cost });
      await updateLocationCostAction({ inventoryItemId: vItem.id, cost: cost === null ? null : 99 });
    }
    const p = await prisma.product.findUniqueOrThrow({ where: { id: s.product.id } });
    expect([num(p.cost), num(p.price), num(p.salePrice)]).toEqual([100, 180, 170]);
    const vv = await prisma.productVariation.findUniqueOrThrow({ where: { id: v.id } });
    expect([num(vv.cost), num(vv.price), num(vv.salePrice)]).toEqual([95, 190, 185]);
    // quantities untouched
    expect((await item(s.casaItem.id)).quantityOnHand).toBe(10);
  });
});
